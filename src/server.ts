import type { Database } from "bun:sqlite";

import {
  DEFAULT_MESSAGE_LIMIT,
  DEFAULT_SESSION_LIMIT,
  type IngestDelta,
  MAX_MESSAGE_LIMIT,
  MAX_SESSION_LIMIT,
  type MessageQuery,
  type SessionQuery,
  type StreamEvent,
} from "./contract.ts";
import { readLiveSessions } from "./live.ts";
import {
  getMessageImage,
  getSession,
  listMessages,
  listProjects,
  listSessions,
  overview,
} from "./queries.ts";

/**
 * The HTTP server: routes `contract.ts`'s API over `queries.ts`'s read layer,
 * and serves the built web UI (if present) for everything else.
 */
export interface ServeOptions {
  db: Database;
  root: string;
  port: number;
  /** Subscribe to ingest deltas; returns an unsubscribe function. */
  subscribe?: (listener: (delta: IngestDelta) => void) => () => void;
}

/**
 * The compiled web UI. `web/index.html` is built by a separate agent and may
 * not exist yet, so the import is dynamic and failures are swallowed - the
 * server should keep answering `/api/*` even with no UI to serve. Top-level
 * await is fine here: it only delays module instantiation, not any call to
 * `startServer`, which stays synchronous.
 */
let indexHtml: Bun.HTMLBundle | false = false;
try {
  const mod = await import("../web/index.html");
  indexHtml = mod.default;
} catch {
  indexHtml = false;
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

/** A malformed request. Caught by `guard` and turned into a 400. */
class BadRequestError extends Error {}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

/**
 * Wraps a route handler so a `BadRequestError` becomes a 400, any other
 * throw becomes a logged 500, and nothing escapes as an unhandled rejection
 * that would take the process down.
 */
function guard<Args extends unknown[]>(
  handler: (...args: Args) => Response | Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof BadRequestError) {
        return json({ error: error.message }, 400);
      }
      console.error("[server]", error);
      return json({ error: "internal error" }, 500);
    }
  };
}

// ---------------------------------------------------------------------------
// Query parameter parsing
// ---------------------------------------------------------------------------

/**
 * Finds a query param's raw (still percent-encoded) value by scanning the
 * query string ourselves. `URLSearchParams` decodes leniently and never
 * throws on a malformed `%XX` escape, which would hide the bad input instead
 * of rejecting it as required for `project`/`agent` (they carry filesystem
 * paths, where silent corruption is worse than a 400).
 */
function rawParam(url: URL, name: string): string | null {
  const prefix = `${name}=`;
  for (const pair of url.search.slice(1).split("&")) {
    if (pair === name) return "";
    if (pair.startsWith(prefix)) return pair.slice(prefix.length);
  }
  return null;
}

/** Strictly decodes a raw query value, rejecting malformed escapes with a 400. */
function decodeParam(url: URL, name: string): string | null {
  const raw = rawParam(url, name);
  if (raw === null) return null;
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    throw new BadRequestError(`malformed ${name} parameter`);
  }
}

/** `project` is a repo path; absent/empty means "every project". */
function resolveProjectId(url: URL): string | undefined {
  const value = decodeParam(url, "project");
  return value === null || value === "" ? undefined : value;
}

/**
 * `agent` selects a thread. Absent, empty, or `main` all mean the session's
 * main thread (`""` on the wire); anything else is a real agent id and must
 * survive untouched so it stays distinguishable from the main thread.
 */
function resolveAgentId(url: URL): string {
  const value = decodeParam(url, "agent");
  if (value === null || value === "" || value === "main") return "";
  return value;
}

function resolveWithAgentsOnly(url: URL): boolean {
  const value = url.searchParams.get("withAgents");
  return value === "true" || value === "1";
}

/** Parses a non-negative integer query param, rejecting anything else as a 400. */
function parseCount(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new BadRequestError(`${name} must be a non-negative integer`);
  }
  return Number(raw);
}

// ---------------------------------------------------------------------------
// Live sessions
// ---------------------------------------------------------------------------

/** Reads live session state and shapes it onto the wire type (Date -> ISO string). */
function liveSessions(root: string) {
  return readLiveSessions(root).map((session) => ({
    pid: session.pid,
    sessionId: session.sessionId,
    cwd: session.cwd,
    name: session.name,
    startedAt: session.startedAt?.toISOString() ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Live stream
// ---------------------------------------------------------------------------

/** How often a heartbeat goes out to every connected client. */
const HEARTBEAT_MS = 15_000;

const streamEncoder = new TextEncoder();

/** Encodes one `StreamEvent` as a single SSE `data:` frame. */
function frame(event: StreamEvent): Uint8Array {
  return streamEncoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * Fans a single serialised event out to every connected `/api/stream`
 * client. Serialising once and writing the same bytes to each controller
 * keeps a delta cheap regardless of how many browsers are watching.
 *
 * A controller that throws (client already gone, but its abort handler
 * hasn't run yet) is dropped on the spot rather than left to error again on
 * the next broadcast.
 */
function makeBroadcaster(clients: Set<ReadableStreamDefaultController<Uint8Array>>) {
  return (event: StreamEvent): void => {
    const bytes = frame(event);
    for (const controller of clients) {
      try {
        controller.enqueue(bytes);
      } catch {
        clients.delete(controller);
      }
    }
  };
}

/**
 * Wires `GET /api/stream`. Connected clients live in `clients`; a shared,
 * refcounted heartbeat timer runs only while at least one client is
 * attached, and `subscribe` (when the caller passes one) is hooked exactly
 * once for the life of the server rather than once per connection.
 */
function streamRoute(
  root: string,
  subscribe: ServeOptions["subscribe"],
): (req: Bun.BunRequest<"/api/stream">) => Response {
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const broadcast = makeBroadcaster(clients);
  const currentLiveSessionIds = () => liveSessions(root).map((session) => session.sessionId);

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const ensureHeartbeat = () => {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      broadcast({ type: "heartbeat", at: new Date().toISOString(), liveSessionIds: currentLiveSessionIds() });
    }, HEARTBEAT_MS);
  };
  const maybeStopHeartbeat = () => {
    if (clients.size === 0 && heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  // One subscription for the server's lifetime, not one per browser tab.
  // Absent when no watcher was wired in, in which case the route still
  // works and just emits heartbeats.
  subscribe?.((delta) => {
    broadcast({
      type: "sync",
      at: new Date().toISOString(),
      sessions: delta.sessions,
      newAgents: delta.newAgents,
      liveSessionIds: currentLiveSessionIds(),
    });
  });

  return (req) => {
    // Reassigned inside `start`, which the stream contract guarantees runs
    // before `cancel` can fire, so this is always the real teardown by the
    // time anything calls it.
    let teardown = () => {};

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        clients.add(controller);
        ensureHeartbeat();

        try {
          // No `data:` field, so this configures the browser's reconnect
          // delay without dispatching a message event.
          controller.enqueue(streamEncoder.encode("retry: 3000\n\n"));
          // Sent immediately so a client is never blank while it waits for
          // the first delta or the first 15s heartbeat.
          controller.enqueue(
            frame({ type: "heartbeat", at: new Date().toISOString(), liveSessionIds: currentLiveSessionIds() }),
          );
        } catch {
          // Client disconnected before its first write landed.
          clients.delete(controller);
          maybeStopHeartbeat();
          return;
        }

        teardown = () => {
          if (!clients.delete(controller)) return; // already torn down
          maybeStopHeartbeat();
          try {
            controller.close();
          } catch {
            // Already closed on the client's side.
          }
        };

        req.signal.addEventListener("abort", teardown);
      },
      cancel() {
        // Bun invokes this when the consumer goes away; the abort listener
        // above covers the same event, so teardown just needs to be
        // idempotent, which the `clients.delete` guard above provides.
        teardown();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function startServer(options: ServeOptions): Bun.Server<undefined> {
  const { db, root, port, subscribe } = options;
  const handleStream = streamRoute(root, subscribe);

  return Bun.serve({
    port,
    // Bun closes a request idle for 10s by default, which is shorter than the
    // stream's 15s heartbeat: a quiet dashboard would have its SSE connection
    // reaped and silently reconnect forever. Long-lived streams need no timeout.
    idleTimeout: 0,
    routes: {
      "/api/overview": guard(() => json(overview(db, liveSessions(root)))),

      "/api/projects": guard(() => json(listProjects(db))),

      "/api/sessions": guard((req: Bun.BunRequest<"/api/sessions">) => {
        const url = new URL(req.url);
        const live = liveSessions(root);
        const query: SessionQuery = {
          projectId: resolveProjectId(url),
          search: url.searchParams.get("search") ?? undefined,
          withAgentsOnly: resolveWithAgentsOnly(url) || undefined,
          limit: Math.min(parseCount(url, "limit", DEFAULT_SESSION_LIMIT), MAX_SESSION_LIMIT),
          offset: parseCount(url, "offset", 0),
        };
        const liveIds = new Set(live.map((session) => session.sessionId));
        return json(listSessions(db, query, liveIds));
      }),

      "/api/sessions/:id": guard((req: Bun.BunRequest<"/api/sessions/:id">) => {
        const live = liveSessions(root);
        const liveIds = new Set(live.map((session) => session.sessionId));
        const session = getSession(db, req.params.id, liveIds);
        if (session === null) {
          return json({ error: `no session "${req.params.id}"` }, 404);
        }
        return json(session);
      }),

      "/api/sessions/:id/messages": guard((req: Bun.BunRequest<"/api/sessions/:id/messages">) => {
        const url = new URL(req.url);
        const query: MessageQuery = {
          agentId: resolveAgentId(url),
          limit: Math.min(parseCount(url, "limit", DEFAULT_MESSAGE_LIMIT), MAX_MESSAGE_LIMIT),
          offset: parseCount(url, "offset", 0),
        };
        return json(listMessages(db, req.params.id, query));
      }),

      /**
       * The bytes of one attached image.
       *
       * Served as its own resource rather than inlined with the message so a
       * page of messages stays small and the browser can cache and lazy-load
       * each image. Transcripts are append-only and an image never changes, so
       * the response is immutable.
       */
      "/api/sessions/:id/messages/:uuid/images/:index": guard(
        (req: Bun.BunRequest<"/api/sessions/:id/messages/:uuid/images/:index">) => {
          const index = Number(req.params.index);
          if (!Number.isInteger(index) || index < 0) {
            throw new BadRequestError("image index must be a non-negative integer");
          }

          const image = getMessageImage(db, req.params.id, req.params.uuid, index);
          if (image === null) return json({ error: "no such image" }, 404);

          return new Response(image.data, {
            headers: {
              "Content-Type": image.mediaType,
              "Cache-Control": "public, max-age=31536000, immutable",
              "Content-Length": String(image.data.byteLength),
            },
          });
        },
      ),

      "/api/live": guard(() => json(liveSessions(root))),

      "/api/stream": guard((req: Bun.BunRequest<"/api/stream">) => handleStream(req)),

      // Everything else is the web UI, when it has been built.
      "/": indexHtml,
      "/*": indexHtml,
    },

    fetch() {
      return json({ error: "not found" }, 404);
    },
  });
}
