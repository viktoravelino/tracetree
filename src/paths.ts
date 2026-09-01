import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Locating the transcript files under a Claude Code config directory.
 *
 * Layout this walks:
 *
 *   <root>/projects/<slug>/<sessionId>.jsonl                    main thread
 *   <root>/projects/<slug>/<sessionId>/subagents/agent-<id>.jsonl   subagent
 *   <root>/projects/<slug>/<sessionId>/subagents/agent-<id>.meta.json
 *   <root>/tasks/<sessionId>/<n>.json                           todo items
 *   <root>/sessions/<pid>.json                                  live sessions
 *
 * The `<slug>` is the session's cwd with separators replaced by dashes, which
 * is lossy (a dash in a directory name is indistinguishable from a separator).
 * We keep it only as a stable id and read the real path from the `cwd` field
 * carried on every transcript line instead.
 */

/** Resolves the config directory, honouring CLAUDE_CONFIG_DIR. */
export function resolveRoot(override?: string): string {
  if (override) return override;
  const fromEnv = process.env.CLAUDE_CONFIG_DIR;
  if (fromEnv) return fromEnv;
  return join(homedir(), ".claude");
}

export interface MainTranscript {
  kind: "session";
  projectSlug: string;
  sessionId: string;
  path: string;
}

export interface AgentTranscript {
  kind: "agent";
  projectSlug: string;
  sessionId: string;
  agentId: string;
  path: string;
  metaPath: string;
}

export type TranscriptFile = MainTranscript | AgentTranscript;

function readDirSafe(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Every transcript under `<root>/projects`, main threads and subagents alike.
 * Subagents are emitted after the session they belong to.
 */
export function discoverTranscripts(root: string): TranscriptFile[] {
  const projectsDir = join(root, "projects");
  const found: TranscriptFile[] = [];

  for (const projectEntry of readDirSafe(projectsDir)) {
    if (!projectEntry.isDirectory()) continue;
    const projectSlug = projectEntry.name;
    const projectDir = join(projectsDir, projectSlug);

    for (const entry of readDirSafe(projectDir)) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const sessionId = entry.name.slice(0, -".jsonl".length);

      found.push({
        kind: "session",
        projectSlug,
        sessionId,
        path: join(projectDir, entry.name),
      });

      // A session grows a sibling directory only once it spawns a subagent.
      const subagentsDir = join(projectDir, sessionId, "subagents");
      if (!existsSync(subagentsDir)) continue;

      for (const agentEntry of readDirSafe(subagentsDir)) {
        if (!agentEntry.isFile()) continue;
        if (!agentEntry.name.startsWith("agent-")) continue;
        if (!agentEntry.name.endsWith(".jsonl")) continue;

        const agentId = agentEntry.name.slice("agent-".length, -".jsonl".length);
        found.push({
          kind: "agent",
          projectSlug,
          sessionId,
          agentId,
          path: join(subagentsDir, agentEntry.name),
          metaPath: join(subagentsDir, `agent-${agentId}.meta.json`),
        });
      }
    }
  }

  return found;
}

/** Session ids that have a `tasks/<sessionId>` directory, with its file paths. */
export function discoverTaskFiles(root: string): Map<string, string[]> {
  const tasksDir = join(root, "tasks");
  const bySession = new Map<string, string[]>();

  for (const entry of readDirSafe(tasksDir)) {
    if (!entry.isDirectory()) continue;
    const dir = join(tasksDir, entry.name);
    const files = readDirSafe(dir)
      .filter((f) => f.isFile() && f.name.endsWith(".json"))
      .map((f) => join(dir, f.name));
    if (files.length > 0) bySession.set(entry.name, files);
  }

  return bySession;
}

/** Paths of the per-pid files describing sessions running right now. */
export function discoverLiveSessionFiles(root: string): string[] {
  const dir = join(root, "sessions");
  return readDirSafe(dir)
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => join(dir, e.name));
}
