import { watch, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";
import type { Database } from "bun:sqlite";

import type { IngestDelta } from "./contract.ts";
import { ingest } from "./ingest.ts";

/**
 * Turns filesystem activity under `<root>/projects` into incremental ingests.
 *
 * One recursive `fs.watch` covers every project, session and subagent, which
 * is the only way to notice a session that did not exist when the process
 * started. Raw events are useless on their own: a session being written emits
 * several per second and names a file rather than what changed in it, so they
 * are coalesced into a set of paths and handed to a single path-scoped
 * `ingest`, whose summary says which sessions actually moved.
 */

export interface WatchOptions {
  db: Database;
  root: string;
  /** Quiet period before a batch is ingested. */
  debounceMs?: number;
  /** Called once per pass that changed something; never with an empty delta. */
  onChange: (delta: IngestDelta) => void;
  onError?: (error: unknown) => void;
}

export interface Watcher {
  stop(): void;
}

const DEFAULT_DEBOUNCE_MS = 400;

/**
 * How long a batch may be held back by fresh events before it is ingested
 * anyway. Without it, a burst arriving faster than the debounce window — three
 * busy sessions all resetting the same timer — would postpone the pass
 * indefinitely and the dashboard would sit still exactly when it matters.
 */
const MAX_WAIT_FACTOR = 5;

/**
 * Starts watching and returns the handle used to stop.
 *
 * The returned watcher owns nothing but the `fs.watch` handle and a timer; the
 * database is the caller's, and is neither opened nor closed here.
 */
export function startWatching(options: WatchOptions): Watcher {
  const { db, root, onChange } = options;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const onError = options.onError ?? ((error: unknown) => console.error("[watch]", error));
  const projectsDir = join(root, "projects");

  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let batchStartedAt = 0;
  let running = false;
  let stopped = false;

  const schedule = (): void => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    const waited = Date.now() - batchStartedAt;
    const delay = Math.max(0, Math.min(debounceMs, debounceMs * MAX_WAIT_FACTOR - waited));
    timer = setTimeout(flush, delay);
  };

  /** Ingests everything collected so far, as one pass. */
  const flush = (): void => {
    timer = null;
    if (stopped || pending.size === 0) return;
    // A pass already in flight owns the current batch; try again after it.
    if (running) {
      schedule();
      return;
    }

    const batch = new Set(pending);
    pending.clear();
    running = true;
    try {
      const summary = ingest(db, { root, only: batch });
      if (summary.messages > 0 || summary.newAgents.length > 0) {
        const delta: IngestDelta = {
          sessions: summary.changedSessions,
          newAgents: summary.newAgents,
          messages: summary.messages,
        };
        onChange(delta);
      }
    } catch (error) {
      // A bad pass is not fatal: the offsets it did not commit are retried on
      // the next event, and the watcher has to outlive the server it feeds.
      onError(error);
    } finally {
      running = false;
      if (pending.size > 0) schedule();
    }
  };

  let watcher: FSWatcher;
  try {
    watcher = watch(projectsDir, { recursive: true }, (_event, filename) => {
      // Only transcripts matter; `agent-<id>.meta.json` rides along with the
      // `.jsonl` event that follows it, and directories carry no lines.
      if (filename === null || !filename.endsWith(".jsonl")) return;

      if (pending.size === 0) batchStartedAt = Date.now();
      pending.add(resolve(projectsDir, filename));
      schedule();
    });
  } catch (error) {
    onError(error);
    return { stop: () => {} };
  }

  watcher.on("error", onError);

  return {
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending.clear();
      watcher.close();
    },
  };
}
