import { Database } from "bun:sqlite";

/**
 * Schema and connection handling for the index.
 *
 * Two conventions worth knowing before writing queries:
 *
 *  - `agent_id` is `''` for the session's main thread, never NULL. SQLite lets
 *    NULLs slip past a composite PRIMARY KEY, which would let duplicate rows in.
 *  - `parent_agent_id` is `''` for a depth-1 subagent, meaning its parent is
 *    the main thread rather than another subagent.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,          -- directory slug under projects/
  path         TEXT,                      -- cwd the first session here started in
  repo_path    TEXT,                      -- canonical git root, shared by worktrees
  name         TEXT                       -- display name, basename of repo_path
);

CREATE TABLE IF NOT EXISTS sessions (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  title                 TEXT,             -- from the ai-title line, if any
  cwd                   TEXT,
  repo_path             TEXT,             -- canonical git root for this session's cwd
  worktree              TEXT,             -- worktree name when the session ran in one
  git_branch            TEXT,
  version               TEXT,
  started_at            TEXT,
  ended_at              TEXT,
  message_count         INTEGER NOT NULL DEFAULT 0,
  agent_count           INTEGER NOT NULL DEFAULT 0,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS agents (
  session_id            TEXT NOT NULL,
  agent_id              TEXT NOT NULL,
  project_id            TEXT NOT NULL,
  agent_type            TEXT,
  description           TEXT,             -- the short label shown when spawned
  tool_use_id           TEXT,             -- the Agent tool_use that created it
  parent_agent_id       TEXT NOT NULL DEFAULT '',
  spawn_depth           INTEGER,
  started_at            TEXT,
  ended_at              TEXT,
  message_count         INTEGER NOT NULL DEFAULT 0,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, agent_id)
);

CREATE TABLE IF NOT EXISTS messages (
  session_id            TEXT NOT NULL,
  agent_id              TEXT NOT NULL DEFAULT '',
  uuid                  TEXT NOT NULL,
  project_id            TEXT NOT NULL,
  parent_uuid           TEXT,
  seq                   INTEGER NOT NULL, -- line order within its own file
  type                  TEXT,
  role                  TEXT,
  model                 TEXT,
  timestamp             TEXT,
  git_branch            TEXT,
  text                  TEXT,             -- flattened text blocks, for preview
  content               TEXT,             -- full content array as JSON
  request_id            TEXT,             -- assistant lines sharing one are one reply
  block_types           TEXT,             -- JSON array of the content block types
  images                TEXT,             -- JSON MessageImage[]; bytes stay in content
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  thinking_tokens       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, agent_id, uuid)
);

CREATE TABLE IF NOT EXISTS tool_uses (
  id               TEXT PRIMARY KEY,      -- the tool_use block's id
  session_id       TEXT NOT NULL,
  agent_id         TEXT NOT NULL DEFAULT '',
  project_id       TEXT NOT NULL,
  message_uuid     TEXT,
  name             TEXT,
  input            TEXT,                  -- JSON
  timestamp        TEXT,
  result           TEXT,                  -- JSON, filled in when the result lands
  is_error         INTEGER NOT NULL DEFAULT 0,
  spawned_agent_id TEXT                   -- set for Agent calls, via agents.tool_use_id
);

CREATE TABLE IF NOT EXISTS tasks (
  session_id  TEXT NOT NULL,
  task_id     TEXT NOT NULL,
  subject     TEXT,
  description TEXT,
  active_form TEXT,
  status      TEXT,
  blocks      TEXT,                        -- JSON array
  blocked_by  TEXT,                        -- JSON array
  PRIMARY KEY (session_id, task_id)
);

-- Byte offset per file so re-ingesting only reads what was appended since.
CREATE TABLE IF NOT EXISTS ingest_state (
  path       TEXT PRIMARY KEY,
  size       INTEGER NOT NULL,
  mtime_ms   INTEGER NOT NULL,
  offset     INTEGER NOT NULL,
  lines      INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

`;

/**
 * Indexes are applied after migrations, not with the tables.
 *
 * `CREATE TABLE IF NOT EXISTS` leaves an existing table untouched, so on an
 * older database a column added by `migrate` does not exist yet when the
 * statements below run. Creating an index over it first fails the whole open.
 */
const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_projects_repo    ON projects(repo_path);
CREATE INDEX IF NOT EXISTS idx_sessions_worktree ON sessions(worktree);
CREATE INDEX IF NOT EXISTS idx_sessions_project  ON sessions(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agents_session    ON agents(session_id, spawn_depth);
CREATE INDEX IF NOT EXISTS idx_agents_parent     ON agents(session_id, parent_agent_id);
CREATE INDEX IF NOT EXISTS idx_agents_tool_use   ON agents(tool_use_id);
CREATE INDEX IF NOT EXISTS idx_messages_request ON messages(session_id, agent_id, request_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread   ON messages(session_id, agent_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_time     ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_tool_uses_name    ON tool_uses(name);
CREATE INDEX IF NOT EXISTS idx_tool_uses_thread  ON tool_uses(session_id, agent_id);
`;

/**
 * Adds columns an older index predates.
 *
 * `CREATE TABLE IF NOT EXISTS` silently leaves an existing table alone, so a
 * database built before a column existed would keep working and quietly return
 * nothing for it. Values stay NULL until the next `ingest --full` backfills them.
 */
function migrate(db: Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map((c) => c.name),
  );
  if (!columns.has("request_id")) db.exec("ALTER TABLE messages ADD COLUMN request_id TEXT");
  if (!columns.has("block_types")) db.exec("ALTER TABLE messages ADD COLUMN block_types TEXT");
  if (!columns.has("images")) db.exec("ALTER TABLE messages ADD COLUMN images TEXT");
}

/** Opens (creating if needed) the index database and applies the schema. */
export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  // WAL still allows only one writer at a time. A second dashboard, or an
  // `ingest` run alongside a running `serve`, would otherwise fail its pass
  // outright with SQLITE_BUSY; wait for the lock instead of throwing.
  db.exec("PRAGMA busy_timeout = 10000");
  db.exec(SCHEMA);
  migrate(db);
  db.exec(INDEXES);
  return db;
}

/** Drops all ingested content, keeping the schema. Used by `ingest --full`. */
export function resetDb(db: Database): void {
  for (const table of [
    "ingest_state",
    "tool_uses",
    "messages",
    "tasks",
    "agents",
    "sessions",
    "projects",
  ]) {
    db.exec(`DELETE FROM ${table}`);
  }
}
