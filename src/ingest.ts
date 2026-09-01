import { readFileSync, statSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { basename } from "node:path";

import type {
  AgentMeta,
  ContentBlock,
  TaskFile,
  TranscriptLine,
  TranscriptMessage,
} from "./types.ts";
import type { TranscriptFile } from "./paths.ts";
import { discoverTaskFiles, discoverTranscripts } from "./paths.ts";
import { resolveRepo } from "./repo.ts";

/**
 * Reads transcripts into the index.
 *
 * Transcripts are append-only, so each file's consumed byte offset is recorded
 * and later runs read only what was added since. Rows are written with INSERT
 * OR REPLACE keyed on their natural identity, which keeps a re-ingest (or a
 * file that got rewritten under us) idempotent rather than duplicated.
 */

export interface IngestOptions {
  root: string;
  /** Ignore stored offsets and read every file from the start. */
  full?: boolean;
  /**
   * Absolute transcript paths this pass may touch; everything else is skipped.
   *
   * Discovery still walks the whole tree, because a subagent file created a
   * moment ago has to become discoverable before it can be read. The set only
   * narrows what is read and, with it, what `finalize` recomputes.
   */
  only?: ReadonlySet<string>;
  onProgress?: (done: number, total: number, path: string) => void;
}

export interface IngestSummary {
  /** Files this pass considered, after `only` was applied. */
  filesSeen: number;
  filesChanged: number;
  linesRead: number;
  messages: number;
  toolUses: number;
  agents: number;
  sessions: number;
  tasks: number;
  /** Sessions whose transcripts gained lines, main thread or subagent alike. */
  changedSessions: string[];
  /** Subagents that had no `agents` row before this pass; see `IngestDelta`. */
  newAgents: { sessionId: string; agentId: string }[];
}

interface PendingSlice {
  lines: string[];
  newOffset: number;
  startSeq: number;
}

/** Reads the whole-line tail of a file that has not been consumed yet. */
function readNewLines(db: Database, path: string, full: boolean): PendingSlice | null {
  let size: number;
  let mtimeMs: number;
  try {
    const st = statSync(path);
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch {
    return null;
  }

  const prior = full
    ? null
    : (db
        .prepare("SELECT size, mtime_ms, offset, lines FROM ingest_state WHERE path = ?")
        .get(path) as { size: number; mtime_ms: number; offset: number; lines: number } | null);

  // Shrinking means the file was rewritten, not appended to; start over.
  let offset = prior !== null && prior !== undefined && size >= prior.offset ? prior.offset : 0;
  let startSeq = offset === 0 ? 0 : (prior?.lines ?? 0);

  if (prior != null && size === prior.size && mtimeMs === prior.mtime_ms && offset === size) {
    return null; // untouched since last run
  }
  if (offset >= size) {
    return null;
  }

  const buf = readFileSync(path);
  const text = buf.subarray(offset).toString("utf8");

  // Stop at the last newline: a trailing partial line means the file is still
  // being written, and we would rather pick it up whole on the next pass.
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) return null;

  const consumed = text.slice(0, lastNewline + 1);
  const newOffset = offset + Buffer.byteLength(consumed, "utf8");
  const lines = consumed.split("\n").filter((l) => l.length > 0);

  db.prepare(
    `INSERT INTO ingest_state (path, size, mtime_ms, offset, lines, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       size = excluded.size, mtime_ms = excluded.mtime_ms,
       offset = excluded.offset, lines = excluded.lines, updated_at = excluded.updated_at`,
  ).run(path, size, mtimeMs, newOffset, startSeq + lines.length, new Date().toISOString());

  return { lines, newOffset, startSeq };
}

function parseLine(raw: string): TranscriptLine | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    return value as TranscriptLine;
  } catch {
    return null;
  }
}

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function blocksOf(content: TranscriptMessageContent): ContentBlock[] {
  return Array.isArray(content) ? content : [];
}

type TranscriptMessageContent = string | ContentBlock[] | undefined;

/**
 * The content block types a message carries, in order.
 *
 * This is what lets a reader tell the three kinds of line apart without parsing
 * the whole payload: a real user turn has `text` (and maybe `image`), whereas a
 * tool result arrives as a `user` line carrying only `tool_result`, and an
 * assistant reply is split across lines holding `thinking`, `text` or `tool_use`.
 */
function blockTypesOf(content: TranscriptMessageContent): string[] {
  if (typeof content === "string") return ["text"];
  return blocksOf(content).map((block) => block.type ?? "unknown");
}

/**
 * Maximum stored message text.
 *
 * This is a hard truncation, not a preview: the reader has no other source for
 * prose, so anything cut here is simply lost from the transcript. It matches the
 * ceiling the UI will render, and sits well above the long-tail message.
 */
const MAX_TEXT = 40_000;

/** Exact decoded length of a base64 string: 3 bytes per 4 chars, less padding. */
function decodedSize(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/**
 * Describes a message's images without their pixels.
 *
 * The base64 stays in `content`, which the reader never selects; this is what
 * lets a page of messages be listed without dragging hundreds of kilobytes of
 * image data through the API for each one.
 */
function imagesOf(content: TranscriptMessageContent): { index: number; mediaType: string; bytes: number }[] {
  const images: { index: number; mediaType: string; bytes: number }[] = [];
  for (const block of blocksOf(content)) {
    if (block.type !== "image") continue;
    const source = (block as { source?: { media_type?: string; data?: string } }).source;
    const data = source?.data;
    images.push({
      index: images.length,
      mediaType: source?.media_type ?? "application/octet-stream",
      bytes: typeof data === "string" ? decodedSize(data) : 0,
    });
  }
  return images;
}

/** Flattens the text blocks of a message into the prose a reader sees. */
function flattenText(content: TranscriptMessageContent): string {
  if (typeof content === "string") return content.slice(0, MAX_TEXT);
  const parts: string[] = [];
  for (const block of blocksOf(content)) {
    if (typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n").slice(0, MAX_TEXT);
}

/**
 * Ingests one transcript file; returns how many rows it produced.
 *
 * `newAgent` is true only when this file's subagent had no `agents` row yet,
 * which is what makes it worth telling a connected UI about. It is decided
 * before the upsert below, since after it every agent looks pre-existing.
 */
function ingestTranscript(
  db: Database,
  file: TranscriptFile,
  slice: PendingSlice,
): { messages: number; toolUses: number; newAgent: boolean } {
  const isAgent = file.kind === "agent";
  const agentId = isAgent ? file.agentId : "";

  const insertMessage = db.prepare(
    `INSERT OR REPLACE INTO messages
       (session_id, agent_id, uuid, project_id, parent_uuid, seq, type, role, model,
        timestamp, git_branch, text, content, request_id, block_types, images,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insertToolUse = db.prepare(
    `INSERT OR REPLACE INTO tool_uses
       (id, session_id, agent_id, project_id, message_uuid, name, input, timestamp,
        result, is_error, spawned_agent_id)
     VALUES (?,?,?,?,?,?,?,?,
             COALESCE((SELECT result FROM tool_uses t WHERE t.id = ?), NULL),
             COALESCE((SELECT is_error FROM tool_uses t WHERE t.id = ?), 0),
             COALESCE((SELECT spawned_agent_id FROM tool_uses t WHERE t.id = ?), NULL))`,
  );
  const attachResult = db.prepare(
    "UPDATE tool_uses SET result = ?, is_error = ? WHERE id = ?",
  );

  let messages = 0;
  let toolUses = 0;
  let title: string | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let version: string | null = null;

  const sessionId = file.sessionId;
  const projectId = file.projectSlug;

  for (let i = 0; i < slice.lines.length; i++) {
    const rawLine = slice.lines[i];
    if (rawLine === undefined) continue;
    const line = parseLine(rawLine);
    if (line === null) continue;

    // First cwd wins: a session that cd's mid-run should keep its origin.
    if (cwd === null && typeof line.cwd === "string") cwd = line.cwd;
    if (typeof line.gitBranch === "string") gitBranch = line.gitBranch;
    if (typeof line.version === "string") version = line.version;
    if (line.type === "ai-title" && typeof line.aiTitle === "string") title = line.aiTitle;

    // A message typed while the assistant was working is not stored as a
    // message at all: it arrives as an `attachment` line of type
    // `queued_command`, holding the same content blocks under `prompt`. Skipping
    // every line without `.message` silently dropped all of them.
    const queued =
      line.type === "attachment" && line.attachment?.type === "queued_command"
        ? line.attachment.prompt
        : undefined;

    const msg: TranscriptMessage | undefined =
      queued !== undefined ? { role: "user", content: queued } : line.message;

    if (msg === undefined || typeof line.uuid !== "string") continue;

    const usage = msg.usage;
    insertMessage.run(
      sessionId,
      agentId,
      line.uuid,
      projectId,
      line.parentUuid ?? null,
      slice.startSeq + i,
      queued !== undefined ? "user" : (line.type ?? null),
      msg.role ?? null,
      msg.model ?? null,
      line.timestamp ?? null,
      gitBranch,
      flattenText(msg.content),
      JSON.stringify(msg.content ?? null),
      line.requestId ?? null,
      JSON.stringify(blockTypesOf(msg.content)),
      JSON.stringify(imagesOf(msg.content)),
      usage?.input_tokens ?? 0,
      usage?.output_tokens ?? 0,
      usage?.cache_read_input_tokens ?? 0,
      usage?.cache_creation_input_tokens ?? 0,
      usage?.output_tokens_details?.thinking_tokens ?? 0,
    );
    messages++;

    for (const block of blocksOf(msg.content)) {
      if (block.type === "tool_use" && typeof block.id === "string") {
        insertToolUse.run(
          block.id,
          sessionId,
          agentId,
          projectId,
          line.uuid,
          block.name ?? null,
          JSON.stringify(block.input ?? null),
          line.timestamp ?? null,
          block.id,
          block.id,
          block.id,
        );
        toolUses++;
      } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        attachResult.run(
          JSON.stringify(block.content ?? null),
          block.is_error === true ? 1 : 0,
          block.tool_use_id,
        );
      }
    }
  }

  db.prepare(
    `INSERT INTO projects (id, path) VALUES (?, ?)
     ON CONFLICT(id) DO UPDATE SET path = COALESCE(projects.path, excluded.path)`,
  ).run(projectId, cwd);

  db.prepare(
    `INSERT INTO sessions (id, project_id, title, cwd, git_branch, version)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       title      = COALESCE(excluded.title, sessions.title),
       cwd        = COALESCE(excluded.cwd, sessions.cwd),
       git_branch = COALESCE(excluded.git_branch, sessions.git_branch),
       version    = COALESCE(excluded.version, sessions.version)`,
  ).run(sessionId, projectId, title, cwd, gitBranch, version);

  let newAgent = false;
  if (isAgent) {
    newAgent =
      db
        .prepare("SELECT 1 FROM agents WHERE session_id = ? AND agent_id = ?")
        .get(sessionId, agentId) == null;

    const meta = readJsonFile<AgentMeta>(file.metaPath) ?? {};
    db.prepare(
      `INSERT INTO agents
         (session_id, agent_id, project_id, agent_type, description, tool_use_id,
          parent_agent_id, spawn_depth)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(session_id, agent_id) DO UPDATE SET
         agent_type      = COALESCE(excluded.agent_type, agents.agent_type),
         description     = COALESCE(excluded.description, agents.description),
         tool_use_id     = COALESCE(excluded.tool_use_id, agents.tool_use_id),
         parent_agent_id = excluded.parent_agent_id,
         spawn_depth     = COALESCE(excluded.spawn_depth, agents.spawn_depth)`,
    ).run(
      sessionId,
      agentId,
      projectId,
      meta.agentType ?? null,
      meta.description ?? null,
      meta.toolUseId ?? null,
      meta.parentAgentId ?? "",
      meta.spawnDepth ?? null,
    );
  }

  return { messages, toolUses, newAgent };
}

/** Reads `tasks/<sessionId>/*.json`. These are small and rewritten in place. */
function ingestTasks(db: Database, root: string): number {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO tasks
       (session_id, task_id, subject, description, active_form, status, blocks, blocked_by)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  let count = 0;

  for (const [sessionId, files] of discoverTaskFiles(root)) {
    for (const path of files) {
      const task = readJsonFile<TaskFile>(path);
      if (task === null) continue;
      const taskId = task.id ?? basename(path, ".json");
      stmt.run(
        sessionId,
        taskId,
        task.subject ?? null,
        task.description ?? null,
        task.activeForm ?? null,
        task.status ?? null,
        JSON.stringify(task.blocks ?? []),
        JSON.stringify(task.blockedBy ?? []),
      );
      count++;
    }
  }

  return count;
}

// ---------------------------------------------------------------------------
// Finalize
// ---------------------------------------------------------------------------

/**
 * The three statements finalize runs, each written without a trailing `WHERE`
 * so the scoped variant can append one. Everything they read is keyed by
 * session, which is what makes scoping to a set of sessions sound.
 */
const LINK_SPAWNED_AGENTS = `
  UPDATE tool_uses SET spawned_agent_id = (
    SELECT a.agent_id FROM agents a
    WHERE a.tool_use_id = tool_uses.id AND a.session_id = tool_uses.session_id
  )
  WHERE name IN ('Agent', 'Task')`;

// One row-value assignment per table rather than a correlated subquery per
// column: seven scans of a thread's messages collapse into one, which halves
// the cost of both the full pass and the scoped one. MIN/MAX skip NULLs
// themselves, so the old `timestamp IS NOT NULL` filters are not needed.
const ROLLUP_AGENTS = `
  UPDATE agents SET
    (message_count, started_at, ended_at,
     input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens) = (
      SELECT COUNT(*), MIN(m.timestamp), MAX(m.timestamp),
             COALESCE(SUM(m.input_tokens),0), COALESCE(SUM(m.output_tokens),0),
             COALESCE(SUM(m.cache_read_tokens),0), COALESCE(SUM(m.cache_creation_tokens),0)
        FROM messages m
       WHERE m.session_id = agents.session_id AND m.agent_id = agents.agent_id)`;

const ROLLUP_SESSIONS = `
  UPDATE sessions SET
    agent_count = (SELECT COUNT(*) FROM agents a WHERE a.session_id = sessions.id),
    (message_count, started_at, ended_at,
     input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens) = (
      SELECT COUNT(*), MIN(m.timestamp), MAX(m.timestamp),
             COALESCE(SUM(m.input_tokens),0), COALESCE(SUM(m.output_tokens),0),
             COALESCE(SUM(m.cache_read_tokens),0), COALESCE(SUM(m.cache_creation_tokens),0)
        FROM messages m WHERE m.session_id = sessions.id)`;

interface ProjectRow {
  id: string;
  path: string | null;
}
interface SessionRow {
  id: string;
  cwd: string;
}

/**
 * Fills in the canonical repository each project and session belongs to.
 *
 * Sessions are resolved separately from projects because they disagree: a
 * worktree session is filed under the slug of the repository it was launched
 * from, so the worktree is only visible on the session's own cwd.
 *
 * `sessionIds` narrows the work to the projects those sessions belong to.
 */
function resolveLocations(db: Database, sessionIds?: ReadonlySet<string>): void {
  let projects: ProjectRow[];
  let sessions: SessionRow[];

  if (sessionIds === undefined) {
    projects = db.prepare("SELECT id, path FROM projects").all() as ProjectRow[];
    sessions = db
      .prepare("SELECT id, cwd FROM sessions WHERE cwd IS NOT NULL")
      .all() as SessionRow[];
  } else {
    const projectOf = db.prepare(
      "SELECT p.id, p.path FROM projects p JOIN sessions s ON s.project_id = p.id WHERE s.id = ?",
    );
    const sessionOf = db.prepare("SELECT id, cwd FROM sessions WHERE id = ? AND cwd IS NOT NULL");
    // Sibling sessions share a project, so dedupe before shelling out to git.
    const byProject = new Map<string, ProjectRow>();
    sessions = [];
    for (const id of sessionIds) {
      const project = projectOf.get(id) as ProjectRow | null;
      if (project !== null) byProject.set(project.id, project);
      const session = sessionOf.get(id) as SessionRow | null;
      if (session !== null) sessions.push(session);
    }
    projects = [...byProject.values()];
  }

  const updateProject = db.prepare("UPDATE projects SET repo_path = ?, name = ? WHERE id = ?");
  for (const row of projects) {
    // Slug-only fallback: the directory is gone, so undo the dash encoding.
    const info = resolveRepo(row.path ?? row.id.replace(/-/g, "/"));
    updateProject.run(info.repoPath, info.name, row.id);
  }

  const updateSession = db.prepare("UPDATE sessions SET repo_path = ?, worktree = ? WHERE id = ?");
  for (const row of sessions) {
    const info = resolveRepo(row.cwd);
    updateSession.run(info.repoPath, info.worktree, row.id);
  }
}

/**
 * Resolves cross-file links and recomputes rollups.
 *
 * Kept as a separate pass because an `Agent` tool_use and the subagent it
 * spawned live in different files, and the spawned one may be read first.
 * Counts and token sums on `sessions` cover the whole tree, subagents included.
 *
 * `sessionIds` scopes the recompute to the sessions that actually moved. The
 * unscoped form walks every session and agent with correlated subqueries over
 * the whole message table, which is fine once per `ingest` run and far too
 * expensive to repeat on every file event the watcher sees. Both rollups are
 * per-session by construction — no row's value depends on another session —
 * so the scoped result is identical to the full one for those rows.
 */
function finalize(db: Database, sessionIds?: ReadonlySet<string>): void {
  resolveLocations(db, sessionIds);

  if (sessionIds === undefined) {
    db.exec(LINK_SPAWNED_AGENTS);
    db.exec(ROLLUP_AGENTS);
    db.exec(ROLLUP_SESSIONS);
    return;
  }

  const link = db.prepare(`${LINK_SPAWNED_AGENTS} AND session_id = ?`);
  const rollupAgents = db.prepare(`${ROLLUP_AGENTS} WHERE agents.session_id = ?`);
  const rollupSession = db.prepare(`${ROLLUP_SESSIONS} WHERE sessions.id = ?`);

  for (const id of sessionIds) {
    link.run(id);
    rollupAgents.run(id);
    rollupSession.run(id);
  }
}

export function ingest(db: Database, options: IngestOptions): IngestSummary {
  const only = options.only;
  // Discovery always walks the tree; `only` filters what came back, so a
  // subagent file that appeared since the last pass is still found.
  const files = discoverTranscripts(options.root).filter(
    (file) => only === undefined || only.has(file.path),
  );

  const changedSessions = new Set<string>();
  const summary: IngestSummary = {
    filesSeen: files.length,
    filesChanged: 0,
    linesRead: 0,
    messages: 0,
    toolUses: 0,
    agents: 0,
    sessions: 0,
    tasks: 0,
    changedSessions: [],
    newAgents: [],
  };

  // BEGIN IMMEDIATE, not BEGIN. A deferred transaction starts out reading and
  // only asks for the write lock later; if another writer holds it by then,
  // SQLite returns SQLITE_BUSY at once and never consults `busy_timeout`,
  // because backing off would mean rolling back work already read. Taking the
  // lock up front is what makes the timeout actually wait.
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file === undefined) continue;
      options.onProgress?.(i + 1, files.length, file.path);

      const slice = readNewLines(db, file.path, options.full === true);
      if (slice === null) continue;

      summary.filesChanged++;
      summary.linesRead += slice.lines.length;
      changedSessions.add(file.sessionId);

      const counts = ingestTranscript(db, file, slice);
      summary.messages += counts.messages;
      summary.toolUses += counts.toolUses;
      if (counts.newAgent && file.kind === "agent") {
        summary.newAgents.push({ sessionId: file.sessionId, agentId: file.agentId });
      }
    }

    summary.changedSessions = [...changedSessions];
    summary.tasks = ingestTasks(db, options.root);
    // A scoped pass only ever moved the sessions it read; recomputing the rest
    // would cost orders of magnitude more than the read itself.
    finalize(db, only === undefined ? undefined : changedSessions);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const counted = db
    .prepare("SELECT (SELECT COUNT(*) FROM agents) AS agents, (SELECT COUNT(*) FROM sessions) AS sessions")
    .get() as { agents: number; sessions: number };
  summary.agents = counted.agents;
  summary.sessions = counted.sessions;

  return summary;
}
