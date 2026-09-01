import type { Database, SQLQueryBindings } from "bun:sqlite";

import {
  DEFAULT_MESSAGE_LIMIT,
  DEFAULT_SESSION_LIMIT,
  MAX_MESSAGE_LIMIT,
  type AgentNode,
  type LiveSessionInfo,
  type Message,
  type MessageImage,
  type MessagePage,
  type MessageQuery,
  type Overview,
  type Project,
  type Queries,
  type SessionDetail,
  type SessionQuery,
  type SessionSummary,
  type TaskItem,
  type TokenCounts,
  type ToolCall,
  type ToolSummary,
} from "./contract.ts";

/**
 * The read layer: every query the server is allowed to run.
 *
 * Nothing here touches the filesystem. Liveness arrives as a set of session
 * ids, so these functions stay a pure function of the database and can be
 * exercised against any index file.
 *
 * Three conventions the SQL below follows throughout:
 *
 *  - A project is a *repository*. `repo_path` is the key everywhere; a
 *    `projects.id` is only a `~/.claude/projects` slug, and several slugs
 *    collapse onto one repo. Sessions carry their own `repo_path`, which is
 *    the one to trust: it is resolved from the session's cwd.
 *  - Counts and token sums on `sessions` already cover the whole spawn tree,
 *    so `agents` is never summed on top of a session.
 *  - `agent_id` / `parent_agent_id` are `''`, never NULL, for "the session's
 *    main thread".
 */

// ---------------------------------------------------------------------------
// Row shapes and small helpers
// ---------------------------------------------------------------------------

/** The four token columns, spelled the same on sessions, agents and messages. */
interface TokenRow {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

function tokens(row: TokenRow): TokenCounts {
  return {
    input: row.input_tokens,
    output: row.output_tokens,
    cacheRead: row.cache_read_tokens,
    cacheCreation: row.cache_creation_tokens,
  };
}

/** Tool payloads are stored as JSON text; a malformed row degrades to its raw string. */
function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/** Repos without a `projects` row still deserve a label; fall back to the basename. */
function displayName(name: string | null, repoPath: string): string {
  if (name !== null && name !== "") return name;
  return repoPath.split("/").filter(Boolean).pop() ?? repoPath;
}

/** Escapes the LIKE wildcards so a search for "100%" is not a search for everything. */
function likeTerm(search: string): string {
  return `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

interface ProjectRow extends TokenRow {
  id: string;
  name: string | null;
  session_count: number;
  agent_count: number;
  message_count: number;
  worktree_count: number;
  last_active: string | null;
}

/**
 * One row per repository, with everything the overview header needs.
 *
 * The repo list is the union of both tables so a project survives either half
 * of the index being incomplete, and the rollup is aggregated *before* the
 * join: joining sessions to the several slugs of one repo would multiply the
 * sums.
 */
export function listProjects(db: Database): Project[] {
  const rows = db
    .query<ProjectRow, []>(
      `WITH repos AS (
         SELECT repo_path FROM projects WHERE repo_path IS NOT NULL
         UNION
         SELECT repo_path FROM sessions WHERE repo_path IS NOT NULL
       ),
       named AS (
         SELECT repo_path, MIN(name) AS name
           FROM projects WHERE repo_path IS NOT NULL GROUP BY repo_path
       ),
       rollup AS (
         SELECT repo_path,
                COUNT(*)                                AS session_count,
                SUM(agent_count)                        AS agent_count,
                SUM(message_count)                      AS message_count,
                COUNT(DISTINCT worktree)                AS worktree_count,
                SUM(input_tokens)                       AS input_tokens,
                SUM(output_tokens)                      AS output_tokens,
                SUM(cache_read_tokens)                  AS cache_read_tokens,
                SUM(cache_creation_tokens)              AS cache_creation_tokens,
                MAX(COALESCE(ended_at, started_at))     AS last_active
           FROM sessions WHERE repo_path IS NOT NULL GROUP BY repo_path
       )
       SELECT r.repo_path                              AS id,
              n.name                                   AS name,
              COALESCE(x.session_count, 0)             AS session_count,
              COALESCE(x.agent_count, 0)               AS agent_count,
              COALESCE(x.message_count, 0)             AS message_count,
              COALESCE(x.worktree_count, 0)            AS worktree_count,
              COALESCE(x.input_tokens, 0)              AS input_tokens,
              COALESCE(x.output_tokens, 0)             AS output_tokens,
              COALESCE(x.cache_read_tokens, 0)         AS cache_read_tokens,
              COALESCE(x.cache_creation_tokens, 0)     AS cache_creation_tokens,
              x.last_active                            AS last_active
         FROM repos r
         LEFT JOIN named  n ON n.repo_path = r.repo_path
         LEFT JOIN rollup x ON x.repo_path = r.repo_path
        ORDER BY x.last_active DESC NULLS LAST, id`,
    )
    .all();

  return rows.map((row) => ({
    id: row.id,
    name: displayName(row.name, row.id),
    sessionCount: row.session_count,
    agentCount: row.agent_count,
    messageCount: row.message_count,
    worktreeCount: row.worktree_count,
    tokens: tokens(row),
    lastActive: row.last_active,
  }));
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

interface StatsRow {
  projects: number;
  sessions: number;
  agents: number;
  messages: number;
  tool_calls: number;
  tasks: number;
}

/** Skill names taken from the `Skill` calls the index recorded. */
function skillNames(db: Database): string[] {
  return db
    .query<{ skill: string | null }, []>(
      `SELECT DISTINCT json_extract(input, '$.skill') AS skill
         FROM tool_uses
        WHERE name = 'Skill' AND json_extract(input, '$.skill') IS NOT NULL
        ORDER BY skill`,
    )
    .all()
    .map((row) => row.skill)
    .filter((name): name is string => name !== null);
}

interface AgentTypeRow {
  agent_type: string | null;
  count: number;
  max_depth: number | null;
}

/**
 * The landing payload: index totals, every project, the live sessions the
 * caller probed, and how often each agent type was spawned.
 *
 * `stats.projects` counts repositories, not slug directories, so it agrees
 * with `projects.length`.
 */
export function overview(db: Database, live: LiveSessionInfo[]): Overview {
  const stats = db
    .query<StatsRow, []>(
      `SELECT (SELECT COUNT(DISTINCT repo_path) FROM projects) AS projects,
              (SELECT COUNT(*) FROM sessions)                  AS sessions,
              (SELECT COUNT(*) FROM agents)                    AS agents,
              (SELECT COUNT(*) FROM messages)                  AS messages,
              (SELECT COUNT(*) FROM tool_uses)                 AS tool_calls,
              (SELECT COUNT(*) FROM tasks)                     AS tasks`,
    )
    .get();

  const agentTypes = db
    .query<AgentTypeRow, []>(
      `SELECT agent_type, COUNT(*) AS count, MAX(spawn_depth) AS max_depth
         FROM agents GROUP BY agent_type ORDER BY count DESC, agent_type`,
    )
    .all();

  return {
    stats: {
      projects: stats?.projects ?? 0,
      sessions: stats?.sessions ?? 0,
      agents: stats?.agents ?? 0,
      messages: stats?.messages ?? 0,
      toolCalls: stats?.tool_calls ?? 0,
      tasks: stats?.tasks ?? 0,
    },
    projects: listProjects(db),
    live,
    agentTypes: agentTypes.map((row) => ({
      agentType: row.agent_type ?? "(unknown)",
      count: row.count,
      maxDepth: row.max_depth ?? 0,
    })),
    skillNames: skillNames(db),
  };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

interface SessionRow extends TokenRow {
  id: string;
  project_id: string;
  project_name: string | null;
  title: string | null;
  cwd: string | null;
  worktree: string | null;
  git_branch: string | null;
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
  agent_count: number;
}

/**
 * A session's own `repo_path` is its project id, and the display name is looked
 * up by that path rather than through `project_id`: the slug a session is filed
 * under can resolve to a different repo than the session's cwd does.
 */
const SESSION_SELECT = `
  SELECT s.id                        AS id,
         COALESCE(s.repo_path, '')   AS project_id,
         p.name                      AS project_name,
         s.title, s.cwd, s.worktree, s.git_branch, s.started_at, s.ended_at,
         s.message_count, s.agent_count,
         s.input_tokens, s.output_tokens, s.cache_read_tokens, s.cache_creation_tokens
    FROM sessions s
    LEFT JOIN (SELECT repo_path, MIN(name) AS name FROM projects GROUP BY repo_path) p
           ON p.repo_path = s.repo_path`;

function toSessionSummary(row: SessionRow, liveSessionIds: Set<string>): SessionSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: displayName(row.project_name, row.project_id),
    title: row.title,
    cwd: row.cwd,
    worktree: row.worktree,
    gitBranch: row.git_branch,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    messageCount: row.message_count,
    agentCount: row.agent_count,
    tokens: tokens(row),
    isLive: liveSessionIds.has(row.id),
  };
}

/** Newest first. `projectId` is a repo path; `search` matches the title only. */
export function listSessions(
  db: Database,
  query: SessionQuery,
  liveSessionIds: Set<string>,
): SessionSummary[] {
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (query.projectId !== undefined) {
    where.push("s.repo_path = ?");
    params.push(query.projectId);
  }
  if (query.search !== undefined && query.search !== "") {
    where.push(`s.title IS NOT NULL AND LOWER(s.title) LIKE LOWER(?) ESCAPE '\\'`);
    params.push(likeTerm(query.search));
  }
  if (query.withAgentsOnly === true) {
    where.push("s.agent_count > 0");
  }

  const limit = clamp(query.limit ?? DEFAULT_SESSION_LIMIT, 1, Number.MAX_SAFE_INTEGER);
  const offset = clamp(query.offset ?? 0, 0, Number.MAX_SAFE_INTEGER);
  params.push(limit, offset);

  const rows = db
    .query<SessionRow, SQLQueryBindings[]>(
      `${SESSION_SELECT}
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY s.ended_at DESC NULLS LAST, s.started_at DESC NULLS LAST, s.id
       LIMIT ? OFFSET ?`,
    )
    .all(...params);

  return rows.map((row) => toSessionSummary(row, liveSessionIds));
}

// ---------------------------------------------------------------------------
// Session detail
// ---------------------------------------------------------------------------

interface AgentRow extends TokenRow {
  agent_id: string;
  parent_agent_id: string;
  agent_type: string | null;
  description: string | null;
  spawn_depth: number | null;
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
  tool_use_id: string | null;
}

interface TaskRow {
  task_id: string;
  subject: string | null;
  description: string | null;
  active_form: string | null;
  status: string | null;
}

interface ToolSummaryRow {
  name: string | null;
  count: number;
  errors: number;
}

/** Oldest first, with the agents that never recorded a start time at the end. */
function byStartedAt(a: AgentNode, b: AgentNode): number {
  if (a.startedAt === b.startedAt) return 0;
  if (a.startedAt === null) return 1;
  if (b.startedAt === null) return -1;
  return a.startedAt < b.startedAt ? -1 : 1;
}

/** True when following `parent_agent_id` upwards from `agentId` loops forever. */
function inCycle(agentId: string, parentOf: Map<string, string>): boolean {
  const seen = new Set<string>([agentId]);
  let current = parentOf.get(agentId);
  while (current !== undefined && current !== "") {
    if (seen.has(current)) return true;
    seen.add(current);
    current = parentOf.get(current);
  }
  return false;
}

/**
 * Nests the flat `agents` rows into the spawn tree, roots first.
 *
 * Two kinds of broken edge are tolerated rather than dropped, because an agent
 * that ran is worth showing even if its parent link is not usable: an agent
 * whose declared parent is missing from the session, and an agent caught in a
 * parent cycle. Both surface at the root.
 */
function buildAgentTree(rows: AgentRow[]): AgentNode[] {
  const nodes = new Map<string, AgentNode>();
  const parentOf = new Map<string, string>();

  for (const row of rows) {
    parentOf.set(row.agent_id, row.parent_agent_id);
    nodes.set(row.agent_id, {
      agentId: row.agent_id,
      parentAgentId: row.parent_agent_id,
      agentType: row.agent_type,
      description: row.description,
      spawnDepth: row.spawn_depth,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      messageCount: row.message_count,
      tokens: tokens(row),
      toolUseId: row.tool_use_id,
      children: [],
    });
  }

  const roots: AgentNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.agent_id);
    if (node === undefined) continue;

    const parent =
      row.parent_agent_id === "" || inCycle(row.agent_id, parentOf)
        ? undefined
        : nodes.get(row.parent_agent_id);

    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }

  const sortDeep = (siblings: AgentNode[]): void => {
    siblings.sort(byStartedAt);
    for (const node of siblings) sortDeep(node.children);
  };
  sortDeep(roots);

  return roots;
}

/** The session plus its spawn tree, todo list, and tool histogram. Null if unknown. */
export function getSession(
  db: Database,
  sessionId: string,
  liveSessionIds: Set<string>,
): SessionDetail | null {
  const row = db
    .query<SessionRow, [string]>(`${SESSION_SELECT} WHERE s.id = ?`)
    .get(sessionId);
  if (row === null) return null;

  const agentRows = db
    .query<AgentRow, [string]>(
      `SELECT agent_id, parent_agent_id, agent_type, description, spawn_depth,
              started_at, ended_at, message_count, tool_use_id,
              input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
         FROM agents WHERE session_id = ?`,
    )
    .all(sessionId);

  const taskRows = db
    .query<TaskRow, [string]>(
      `SELECT task_id, subject, description, active_form, status
         FROM tasks WHERE session_id = ? ORDER BY task_id`,
    )
    .all(sessionId);

  // Covers the whole tree: tool calls made by subagents carry the same session id.
  const toolRows = db
    .query<ToolSummaryRow, [string]>(
      `SELECT name, COUNT(*) AS count, SUM(is_error) AS errors
         FROM tool_uses WHERE session_id = ?
        GROUP BY name ORDER BY count DESC, name`,
    )
    .all(sessionId);

  const tasks: TaskItem[] = taskRows.map((task) => ({
    id: task.task_id,
    subject: task.subject,
    description: task.description,
    activeForm: task.active_form,
    status: task.status,
  }));

  const tools: ToolSummary[] = toolRows.map((tool) => ({
    name: tool.name ?? "(unknown)",
    count: tool.count,
    errors: tool.errors,
  }));

  return {
    ...toSessionSummary(row, liveSessionIds),
    agents: buildAgentTree(agentRows),
    tasks,
    tools,
  };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

interface MessageRow extends TokenRow {
  uuid: string;
  agent_id: string;
  parent_uuid: string | null;
  seq: number;
  type: string | null;
  role: string | null;
  model: string | null;
  timestamp: string | null;
  text: string | null;
  request_id: string | null;
  block_types: string | null;
  images: string | null;
  thinking_tokens: number;
}

/** Older rows predate `images`; an unreadable value is treated as none. */
function parseImages(raw: string | null): MessageImage[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is MessageImage =>
        typeof v === "object" &&
        v !== null &&
        typeof (v as MessageImage).index === "number" &&
        typeof (v as MessageImage).mediaType === "string",
    );
  } catch {
    return [];
  }
}

/**
 * The bytes of one image, decoded from the message that carries it.
 *
 * Reads `content` deliberately - the only place the base64 lives - so this is
 * the one query that pays for it, once per image rather than per page.
 */
export function getMessageImage(
  db: Database,
  sessionId: string,
  uuid: string,
  index: number,
): { mediaType: string; data: ArrayBuffer } | null {
  const row = db
    .query<{ content: string | null }, [string, string]>(
      "SELECT content FROM messages WHERE session_id = ? AND uuid = ? LIMIT 1",
    )
    .get(sessionId, uuid);
  if (!row?.content) return null;

  let blocks: unknown;
  try {
    blocks = JSON.parse(row.content);
  } catch {
    return null;
  }
  if (!Array.isArray(blocks)) return null;

  const images = blocks.filter(
    (b): b is { source?: { media_type?: string; data?: string } } =>
      typeof b === "object" && b !== null && (b as { type?: string }).type === "image",
  );
  const source = images[index]?.source;
  if (typeof source?.data !== "string") return null;

  // `Buffer.from` can allocate inside a pooled buffer, so the underlying
  // ArrayBuffer may hold unrelated bytes either side of this one. Slice to the
  // exact window rather than handing the whole pool to the response.
  const bytes = Buffer.from(source.data, "base64");
  return {
    mediaType: source.media_type ?? "application/octet-stream",
    data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
}

/** Older rows predate `block_types`; an unreadable value is treated as absent. */
function parseBlockTypes(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

interface ToolCallRow {
  id: string;
  message_uuid: string | null;
  name: string | null;
  input: string | null;
  result: string | null;
  is_error: number;
  spawned_agent_id: string | null;
}

/**
 * One page of a single thread, in transcript order.
 *
 * `agentId` selects the thread — `''`, the default, is the main thread — and
 * `total` counts that thread, not the page. The page's tool calls are fetched
 * in one extra query keyed by the uuids on the page, passed as a JSON array so
 * the statement text stays constant however large the page is.
 */
export function listMessages(db: Database, sessionId: string, query: MessageQuery): MessagePage {
  const agentId = query.agentId ?? "";
  const limit = clamp(query.limit ?? DEFAULT_MESSAGE_LIMIT, 1, MAX_MESSAGE_LIMIT);
  const offset = clamp(query.offset ?? 0, 0, Number.MAX_SAFE_INTEGER);

  const total =
    db
      .query<{ total: number }, [string, string]>(
        "SELECT COUNT(*) AS total FROM messages WHERE session_id = ? AND agent_id = ?",
      )
      .get(sessionId, agentId)?.total ?? 0;

  const rows = db
    .query<MessageRow, [string, string, number, number]>(
      `SELECT uuid, agent_id, parent_uuid, seq, type, role, model, timestamp, text,
              request_id, block_types, images,
              input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
              thinking_tokens
         FROM messages WHERE session_id = ? AND agent_id = ?
        ORDER BY seq LIMIT ? OFFSET ?`,
    )
    .all(sessionId, agentId, limit, offset);

  const callsByMessage = new Map<string, ToolCall[]>();
  if (rows.length > 0) {
    const toolRows = db
      .query<ToolCallRow, [string, string, string]>(
        `SELECT id, message_uuid, name, input, result, is_error, spawned_agent_id
           FROM tool_uses
          WHERE session_id = ? AND agent_id = ?
            AND message_uuid IN (SELECT value FROM json_each(?))
          ORDER BY timestamp, id`,
      )
      .all(sessionId, agentId, JSON.stringify(rows.map((row) => row.uuid)));

    for (const tool of toolRows) {
      if (tool.message_uuid === null) continue;
      const calls = callsByMessage.get(tool.message_uuid) ?? [];
      calls.push({
        id: tool.id,
        name: tool.name,
        input: parseJson(tool.input),
        result: parseJson(tool.result),
        isError: tool.is_error !== 0,
        spawnedAgentId: tool.spawned_agent_id,
      });
      callsByMessage.set(tool.message_uuid, calls);
    }
  }

  const messages: Message[] = rows.map((row) => ({
    uuid: row.uuid,
    agentId: row.agent_id,
    parentUuid: row.parent_uuid,
    seq: row.seq,
    type: row.type,
    role: row.role,
    model: row.model,
    timestamp: row.timestamp,
    text: row.text,
    requestId: row.request_id,
    blockTypes: parseBlockTypes(row.block_types),
    images: parseImages(row.images),
    tokens: tokens(row),
    thinkingTokens: row.thinking_tokens,
    toolCalls: callsByMessage.get(row.uuid) ?? [],
  }));

  return { messages, total, offset, limit };
}

/** Compile-time proof that the server can rely on the `Queries` contract. */
const _conforms = {
  overview,
  listProjects,
  listSessions,
  getSession,
  listMessages,
} satisfies Queries;
void _conforms;
