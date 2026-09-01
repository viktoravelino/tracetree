import { useCallback, useEffect, useRef, useState } from "react";
import type { StreamEvent } from "../src/contract.ts";

/**
 * The live connection to `GET /api/stream`.
 *
 * The endpoint may be missing (the server is built in parallel) or may drop at
 * any time, so this hook owns its own reconnection with an exponential backoff
 * instead of leaning on `EventSource`'s built-in retry: the built-in retry gives
 * up entirely on a non-200 response, which is exactly the 404 case we have to
 * survive, and it hammers a fixed short interval in every other case.
 */

/** The `sync` arm of the wire union, named so callers can take it as an arg. */
export type SyncEvent = Extract<StreamEvent, { type: "sync" }>;

export type StreamStatus =
  /** First attempt of this page load; nothing has arrived yet. */
  | "connecting"
  /** Connected, events are flowing. */
  | "open"
  /** Was open, the connection dropped, a retry is scheduled. */
  | "reconnecting"
  /** Never opened — the route is most likely not served at all. */
  | "unavailable";

/** Backoff schedule in ms; the last entry is the ceiling and repeats. */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;

export interface StreamState {
  status: StreamStatus;
  /**
   * Liveness as of the last event. `null` until the first one arrives, which is
   * what tells the UI to fall back to whatever the REST payloads claimed. The
   * value is deliberately kept when the connection drops so the view does not
   * go blank — `status` is what says whether to trust it.
   */
  liveSessionIds: ReadonlySet<string> | null;
  /** `at` of the last event of any kind, for "last update" in the header. */
  lastEventAt: string | null;
  /** Failed attempts since the last successful connection; 0 while healthy. */
  attempt: number;
  /** Abandon the current backoff and reconnect immediately. */
  retryNow: () => void;
}

/**
 * Subscribes to the event stream. `onSync` is called for every `sync` frame and
 * is read through a ref, so an inline closure will not tear down the connection.
 */
export function useStream(onSync: (event: SyncEvent) => void, url = "/api/stream"): StreamState {
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [liveSessionIds, setLiveSessionIds] = useState<ReadonlySet<string> | null>(null);
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Bumped by `retryNow`; re-running the effect is the reconnect.
  const [nonce, setNonce] = useState(0);

  const onSyncRef = useRef(onSync);
  onSyncRef.current = onSync;

  useEffect(() => {
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let failures = 0;

    const connect = () => {
      if (stopped) return;
      const es = new EventSource(url);
      source = es;
      // Per-connection: distinguishes "the server hung up on us" from "there is
      // nothing listening on this route at all".
      let opened = false;

      es.onopen = () => {
        opened = true;
        failures = 0;
        setAttempt(0);
        setStatus("open");
      };

      es.onmessage = (event) => {
        const data: unknown = event.data;
        if (typeof data !== "string") return;
        const parsed = parseStreamEvent(data);
        if (parsed === null) return;
        opened = true;
        setStatus("open");
        setLastEventAt(parsed.at);
        setLiveSessionIds(new Set(parsed.liveSessionIds));
        if (parsed.type === "sync") onSyncRef.current(parsed);
      };

      es.onerror = () => {
        // `EventSource` will not usefully retry a 404, and its own retry for a
        // dropped connection is a fixed short interval. Close it and own the
        // schedule ourselves.
        es.close();
        if (stopped) return;
        const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)] ?? 30_000;
        failures += 1;
        setAttempt(failures);
        setStatus(opened ? "reconnecting" : "unavailable");
        timer = setTimeout(connect, wait);
      };
    };

    connect();

    /**
     * Collapse the backoff whenever the tab is looked at.
     *
     * The ladder ends at 30s, which is sensible for an unattended tab and far
     * too long for one someone just switched to: a dev server restarting a few
     * times is enough to reach the top of the ladder, and the dashboard then
     * sits visibly stale for half a minute. Returning to the tab is the
     * strongest signal that staleness now costs something, so retry at once.
     */
    const reconnectIfIdle = () => {
      if (stopped || document.visibilityState !== "visible") return;
      if (source?.readyState === EventSource.OPEN) return;
      clearTimeout(timer);
      failures = 0;
      setAttempt(0);
      connect();
    };

    document.addEventListener("visibilitychange", reconnectIfIdle);
    window.addEventListener("focus", reconnectIfIdle);
    window.addEventListener("online", reconnectIfIdle);

    return () => {
      stopped = true;
      clearTimeout(timer);
      source?.close();
      document.removeEventListener("visibilitychange", reconnectIfIdle);
      window.removeEventListener("focus", reconnectIfIdle);
      window.removeEventListener("online", reconnectIfIdle);
    };
  }, [url, nonce]);

  const retryNow = useCallback(() => {
    setStatus("connecting");
    setAttempt(0);
    setNonce((value) => value + 1);
  }, []);

  return { status, liveSessionIds, lastEventAt, attempt, retryNow };
}

/** How long to wait before the next attempt, for display only. */
export function backoffDelayMs(attempt: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempt - 1, 0), BACKOFF_MS.length - 1)] ?? 30_000;
}

/**
 * Frames come off the wire as text, so nothing about them is trustworthy until
 * it has been checked. Anything that does not match the contract is dropped
 * rather than coerced — a half-parsed event would silently corrupt the view.
 */
function parseStreamEvent(raw: string): StreamEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record: Record<string, unknown> = value as Record<string, unknown>;

  const at = record.at;
  const liveSessionIds = stringArray(record.liveSessionIds);
  if (typeof at !== "string" || liveSessionIds === null) return null;

  if (record.type === "heartbeat") return { type: "heartbeat", at, liveSessionIds };

  if (record.type === "sync") {
    const sessions = stringArray(record.sessions);
    const newAgents = agentRefArray(record.newAgents);
    if (sessions === null || newAgents === null) return null;
    return { type: "sync", at, sessions, newAgents, liveSessionIds };
  }

  return null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

function agentRefArray(value: unknown): SyncEvent["newAgents"] | null {
  if (!Array.isArray(value)) return null;
  const out: SyncEvent["newAgents"] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const { sessionId, agentId } = item as Record<string, unknown>;
    if (typeof sessionId !== "string" || typeof agentId !== "string") return null;
    out.push({ sessionId, agentId });
  }
  return out;
}
