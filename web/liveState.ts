import type { SyncEvent } from "./useStream.ts";

/**
 * What the app remembers from the event stream, on top of what the REST calls
 * returned.
 *
 * A `sync` names ids rather than carrying rows, so the point of this state is
 * to decide *what to refetch*: only the session actually on screen pays for a
 * reload, and the expensive list calls are coalesced separately. Keeping it as
 * plain data (rather than firing fetches from the event handler) also means a
 * burst of syncs collapses into one render.
 */
export interface LiveOverlay {
  /**
   * Session id -> how many syncs have named it. Used as a fetch dependency:
   * only the panes showing that session see the number change.
   */
  revisions: ReadonlyMap<string, number>;
  /**
   * Session id -> agent id -> when the "just spawned" mark expires. Subagents
   * appearing mid-session is the moment worth watching, so they are flagged in
   * the tree for a while rather than silently blending in.
   */
  freshAgents: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

/** How long a newly spawned subagent stays marked in the tree. */
export const FRESH_AGENT_MS = 20_000;

export const EMPTY_OVERLAY: LiveOverlay = { revisions: new Map(), freshAgents: new Map() };

const NO_AGENTS: ReadonlySet<string> = new Set<string>();

export function revisionOf(overlay: LiveOverlay, sessionId: string | null): number {
  if (sessionId === null) return 0;
  return overlay.revisions.get(sessionId) ?? 0;
}

export function freshAgentsOf(overlay: LiveOverlay, sessionId: string | null): ReadonlySet<string> {
  if (sessionId === null) return NO_AGENTS;
  const bucket = overlay.freshAgents.get(sessionId);
  if (bucket === undefined || bucket.size === 0) return NO_AGENTS;
  return new Set(bucket.keys());
}

/**
 * Folds one `sync` into the overlay.
 *
 * A session that spawned a new agent must also have gained lines, so in
 * practice it is always in `sessions` too; bumping it from `newAgents` as well
 * costs nothing and means a server that only reports the agent still refreshes
 * the tree.
 */
export function applySync(
  previous: LiveOverlay,
  event: SyncEvent,
  now: number = Date.now(),
): LiveOverlay {
  const revisions = new Map(previous.revisions);
  for (const sessionId of event.sessions) {
    revisions.set(sessionId, (revisions.get(sessionId) ?? 0) + 1);
  }

  let freshAgents = previous.freshAgents;
  if (event.newAgents.length > 0) {
    const next = new Map<string, Map<string, number>>();
    for (const [sessionId, agents] of previous.freshAgents) next.set(sessionId, new Map(agents));
    for (const { sessionId, agentId } of event.newAgents) {
      if (!event.sessions.includes(sessionId)) {
        revisions.set(sessionId, (revisions.get(sessionId) ?? 0) + 1);
      }
      const bucket = next.get(sessionId) ?? new Map<string, number>();
      bucket.set(agentId, now + FRESH_AGENT_MS);
      next.set(sessionId, bucket);
    }
    freshAgents = next;
  }

  return { revisions, freshAgents };
}

/** When the earliest "just spawned" mark lapses, or `null` if none are set. */
export function nextExpiry(overlay: LiveOverlay): number | null {
  let earliest: number | null = null;
  for (const bucket of overlay.freshAgents.values()) {
    for (const at of bucket.values()) {
      if (earliest === null || at < earliest) earliest = at;
    }
  }
  return earliest;
}

/** Drops lapsed marks. Returns the same object when nothing changed. */
export function pruneFresh(overlay: LiveOverlay, now: number = Date.now()): LiveOverlay {
  let changed = false;
  const freshAgents = new Map<string, ReadonlyMap<string, number>>();
  for (const [sessionId, bucket] of overlay.freshAgents) {
    const kept = new Map<string, number>();
    for (const [agentId, at] of bucket) {
      if (at > now) kept.set(agentId, at);
      else changed = true;
    }
    if (kept.size > 0) freshAgents.set(sessionId, kept);
  }
  return changed ? { revisions: overlay.revisions, freshAgents } : overlay;
}
