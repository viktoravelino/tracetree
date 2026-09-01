import type { Database } from "bun:sqlite";

/**
 * The shared contract between the read layer, the HTTP server, and the web UI.
 *
 * These types are the single source of truth for what crosses the wire. The
 * server may only expose what `Queries` returns, and the UI may only rely on
 * what is declared here.
 *
 * A note on identity: a "project" to the user is a repository, not a directory
 * under `~/.claude/projects`. Several slugs collapse onto one repository once
 * subdirectories and worktrees are resolved, so `Project.id` is the canonical
 * `repo_path`, not the slug. Slugs stay an internal detail of the index.
 */

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface Project {
  /** Canonical repository path; the key used everywhere a project is named. */
  id: string;
  name: string;
  sessionCount: number;
  agentCount: number;
  messageCount: number;
  worktreeCount: number;
  tokens: TokenCounts;
  lastActive: string | null;
}

export interface SessionSummary {
  id: string;
  projectId: string;
  projectName: string;
  title: string | null;
  cwd: string | null;
  /** Set when the session ran inside a worktree rather than the repo root. */
  worktree: string | null;
  gitBranch: string | null;
  startedAt: string | null;
  endedAt: string | null;
  messageCount: number;
  agentCount: number;
  tokens: TokenCounts;
  /** True when a process for this session is running right now. */
  isLive: boolean;
}

/** A subagent and everything it spawned. */
export interface AgentNode {
  agentId: string;
  /** Empty string means the session's main thread is the parent. */
  parentAgentId: string;
  agentType: string | null;
  description: string | null;
  spawnDepth: number | null;
  startedAt: string | null;
  endedAt: string | null;
  messageCount: number;
  tokens: TokenCounts;
  /** The `Agent` tool call that spawned this one; absent in a few meta files. */
  toolUseId: string | null;
  children: AgentNode[];
}

export interface TaskItem {
  id: string;
  subject: string | null;
  description: string | null;
  activeForm: string | null;
  status: string | null;
}

export interface ToolSummary {
  name: string;
  count: number;
  errors: number;
}

export interface SessionDetail extends SessionSummary {
  /** Agents whose parent is the main thread; deeper ones nest via `children`. */
  agents: AgentNode[];
  tasks: TaskItem[];
  tools: ToolSummary[];
}

export interface ToolCall {
  id: string;
  name: string | null;
  input: unknown;
  result: unknown;
  isError: boolean;
  /** Set on `Agent` calls that resolved to a subagent in this session. */
  spawnedAgentId: string | null;
}

/**
 * An image attached to a message.
 *
 * Deliberately carries no pixels. Images are stored inline in the transcript as
 * base64 and run to hundreds of kilobytes each, so a page of a hundred messages
 * would be tens of megabytes of JSON before anything rendered. The descriptor
 * is enough to lay out a placeholder and build the URL that fetches the bytes,
 * which the browser can then cache and load lazily.
 */
export interface MessageImage {
  /** Position among the message's image blocks; part of its URL. */
  index: number;
  mediaType: string;
  /** Decoded size, for deciding what to load eagerly. */
  bytes: number;
}

export interface Message {
  uuid: string;
  /** Empty string for the main thread, otherwise the owning agent. */
  agentId: string;
  parentUuid: string | null;
  seq: number;
  type: string | null;
  role: string | null;
  model: string | null;
  timestamp: string | null;
  text: string | null;
  /**
   * Assistant lines sharing a request id are one reply that the transcript
   * split across several lines (thinking, then text, then each tool call).
   */
  requestId: string | null;
  /**
   * Content block types in order, e.g. `["thinking"]`, `["tool_use"]`,
   * `["tool_result"]`, `["text","image"]`. Distinguishes a real user turn from
   * a tool result, which arrives as a `user` line carrying only `tool_result`.
   * Empty for rows indexed before this was recorded.
   */
  blockTypes: string[];
  /** Attached images, without their bytes; see `MessageImage`. */
  images: MessageImage[];
  tokens: TokenCounts;
  thinkingTokens: number;
  toolCalls: ToolCall[];
}

export interface MessagePage {
  messages: Message[];
  total: number;
  offset: number;
  limit: number;
}

export interface LiveSessionInfo {
  pid: number;
  sessionId: string;
  cwd: string | null;
  name: string | null;
  startedAt: string | null;
}

export interface IndexStats {
  projects: number;
  sessions: number;
  agents: number;
  messages: number;
  toolCalls: number;
  tasks: number;
}

export interface Overview {
  /** Version of the running server, not the latest published release. */
  version: string;
  stats: IndexStats;
  projects: Project[];
  live: LiveSessionInfo[];
  /** Spawn counts by agent type, for the overview header. */
  agentTypes: { agentType: string; count: number; maxDepth: number }[];
  /**
   * Every skill name the index has seen invoked.
   *
   * A `$name` mention is only text in the transcript, so recognising one means
   * checking the name against skills that actually exist. Without this list the
   * same pattern matches shell variables like `$IMG` and `$PUBLISHED`.
   */
  skillNames: string[];
}

// ---------------------------------------------------------------------------
// Read layer
// ---------------------------------------------------------------------------

export interface SessionQuery {
  /** Canonical repo path. Omit for every project. */
  projectId?: string;
  /** Case-insensitive match against session title. */
  search?: string;
  /** Only sessions that spawned at least one subagent. */
  withAgentsOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface MessageQuery {
  /** Thread to read: an agent id, or `""` for the main thread. */
  agentId?: string;
  limit?: number;
  offset?: number;
}

/**
 * Everything the server is allowed to read. Implemented by `queries.ts`.
 *
 * `liveSessionIds` is passed in rather than read from disk here, so the read
 * layer stays a pure function of the database.
 */
export interface Queries {
  overview(db: Database, live: LiveSessionInfo[]): Omit<Overview, "version">;
  listProjects(db: Database): Project[];
  listSessions(db: Database, query: SessionQuery, liveSessionIds: Set<string>): SessionSummary[];
  getSession(db: Database, sessionId: string, liveSessionIds: Set<string>): SessionDetail | null;
  listMessages(db: Database, sessionId: string, query: MessageQuery): MessagePage;
}

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------

/**
 * What one incremental pass actually changed.
 *
 * Produced by the watcher after it re-ingests the files that grew, and mapped
 * almost directly onto the wire event below. It names ids rather than carrying
 * rows so a client can decide whether the change is even on screen before
 * paying to fetch it.
 */
export interface IngestDelta {
  /** Sessions whose transcripts gained lines, main thread or subagent alike. */
  sessions: string[];
  /** Subagents seen for the first time, so an open tree can grow in place. */
  newAgents: { sessionId: string; agentId: string }[];
  /** How many message rows were written; 0 means nothing user-visible moved. */
  messages: number;
}

/**
 * Server-sent event pushed on `GET /api/stream`.
 *
 * `sync` follows an ingest that changed something. `heartbeat` carries no
 * delta and exists to refresh liveness and to keep the connection from being
 * reaped by an idle proxy — a session ending is not a file change, so without
 * it a stale "live" badge would never clear.
 */
export type StreamEvent =
  | {
      type: "sync";
      at: string;
      sessions: string[];
      newAgents: { sessionId: string; agentId: string }[];
      liveSessionIds: string[];
    }
  | { type: "heartbeat"; at: string; liveSessionIds: string[] };

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

/**
 * Routes the server exposes. Project ids are repository paths, so they must be
 * percent-encoded when used as a query parameter.
 *
 *   GET /api/overview                        -> Overview
 *   GET /api/projects                        -> Project[]
 *   GET /api/sessions?project=&search=&withAgents=&limit=&offset=
 *                                            -> SessionSummary[]
 *   GET /api/sessions/:id                    -> SessionDetail   (404 if unknown)
 *   GET /api/sessions/:id/messages?agent=&limit=&offset=
 *                                            -> MessagePage
 *   GET /api/live                            -> LiveSessionInfo[]
 *   GET /api/stream                          -> text/event-stream of StreamEvent
 *   GET /api/sessions/:id/messages/:uuid/images/:index
 *                                            -> the image bytes, or 404
 *
 * Errors are `{ error: string }` with a 4xx/5xx status.
 */
export const DEFAULT_MESSAGE_LIMIT = 100;
export const MAX_MESSAGE_LIMIT = 500;
export const DEFAULT_SESSION_LIMIT = 100;
export const MAX_SESSION_LIMIT = 500;
