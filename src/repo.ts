import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";

/**
 * Mapping a session's working directory to the repository it belongs to.
 *
 * Two things make the raw `cwd` a poor project key. A session started in a
 * subdirectory (`myrepo/src/frontend`) records that subdirectory, and a
 * session in a worktree (`myrepo/.claude/worktrees/feature-x`) records a path
 * that looks unrelated to the repo it is a checkout of. Asking git collapses
 * both cases onto the same canonical root.
 */

export interface RepoInfo {
  /** Canonical repository root; falls back to the cwd for non-repo paths. */
  repoPath: string;
  /** Worktree name when the cwd is a linked worktree, otherwise null. */
  worktree: string | null;
  /** Display name for the project. */
  name: string;
}

function git(cwd: string, args: string[]): string | null {
  const proc = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (proc.exitCode !== 0) return null;
  const out = proc.stdout.toString().trim();
  return out.length > 0 ? out : null;
}

const cache = new Map<string, RepoInfo>();

/** How Claude Code names the worktrees it creates inside a repository. */
const WORKTREE_SEGMENT = "/.claude/worktrees/";

/**
 * Resolves the repository root for a working directory.
 *
 * `--git-common-dir` is the key: inside a linked worktree it points at the
 * *main* repository's `.git`, so its parent is the shared root, while inside a
 * normal checkout it points at that checkout's own `.git`. Results are cached
 * because many sessions share a directory, and a missing path (a deleted
 * worktree) degrades to using the cwd as-is rather than failing.
 */
export function resolveRepo(cwd: string): RepoInfo {
  const cached = cache.get(cwd);
  if (cached !== undefined) return cached;

  let info: RepoInfo = { repoPath: cwd, worktree: null, name: basename(cwd) || cwd };

  // Worktrees are short-lived and usually deleted by the time we index them,
  // so fall back to the path convention git can no longer be asked about.
  const marker = cwd.indexOf(WORKTREE_SEGMENT);
  if (marker !== -1) {
    const repoPath = cwd.slice(0, marker);
    const rest = cwd.slice(marker + WORKTREE_SEGMENT.length);
    const worktree = rest.split("/")[0] ?? null;
    info = { repoPath, worktree, name: basename(repoPath) || repoPath };
  }

  if (existsSync(cwd)) {
    const commonDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const topLevel = git(cwd, ["rev-parse", "--show-toplevel"]);

    const repoPath =
      commonDir !== null && basename(commonDir) === ".git"
        ? dirname(commonDir)
        : topLevel ?? cwd;

    // A linked worktree's own root differs from the shared repository root.
    const worktree =
      topLevel !== null && topLevel !== repoPath ? basename(topLevel) : null;

    info = { repoPath, worktree, name: basename(repoPath) || repoPath };
  }

  cache.set(cwd, info);
  return info;
}
