import { readFileSync } from "node:fs";
import { basename } from "node:path";

import type { LiveSessionFile } from "./types.ts";
import { discoverLiveSessionFiles } from "./paths.ts";

/**
 * Sessions running right now.
 *
 * These live in `<root>/sessions/<pid>.json` and are not part of the SQLite
 * index: they are ephemeral process state, true only at the moment you read
 * them. Files can outlive the process that wrote them, so each pid is probed
 * with signal 0 and the dead ones are dropped.
 */

export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd: string | null;
  name: string | null;
  kind: string | null;
  version: string | null;
  startedAt: Date | null;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLiveSessions(root: string): LiveSession[] {
  const sessions: LiveSession[] = [];

  for (const path of discoverLiveSessionFiles(root)) {
    let parsed: LiveSessionFile;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as LiveSessionFile;
    } catch {
      continue;
    }

    const pid = parsed.pid ?? Number(basename(path, ".json"));
    if (!Number.isFinite(pid) || !isRunning(pid)) continue;
    if (typeof parsed.sessionId !== "string") continue;

    sessions.push({
      pid,
      sessionId: parsed.sessionId,
      cwd: parsed.cwd ?? null,
      name: parsed.name ?? null,
      kind: parsed.kind ?? null,
      version: parsed.version ?? null,
      startedAt: typeof parsed.startedAt === "number" ? new Date(parsed.startedAt) : null,
    });
  }

  return sessions.toSorted((a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0));
}
