#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";

import { openDb, resetDb } from "./db.ts";
import { ingest } from "./ingest.ts";
import { readLiveSessions } from "./live.ts";
import { resolveRoot } from "./paths.ts";
import { startServer } from "./server.ts";
import { startWatching } from "./watch.ts";
import type { IngestDelta } from "./contract.ts";

const PACKAGE_ROOT = join(import.meta.dirname, "..");
const DEFAULT_DB = join(PACKAGE_ROOT, "data", "index.db");

interface Flags {
  root: string;
  db: string;
  full: boolean;
  json: boolean;
  limit: number;
  port: number;
  watch: boolean;
  positionals: string[];
}

function parseFlags(argv: string[]): Flags {
  const positionals: string[] = [];
  let root: string | undefined;
  let db: string | undefined;
  let full = false;
  let json = false;
  let limit = 20;
  let port = 4000;
  let watch = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--full") full = true;
    else if (arg === "--json") json = true;
    else if (arg === "--no-watch") watch = false;
    else if (arg === "--root") root = argv[++i];
    else if (arg === "--db") db = argv[++i];
    else if (arg === "--limit") limit = Number(argv[++i] ?? limit);
    else if (arg === "--port") port = Number(argv[++i] ?? port);
    else positionals.push(arg);
  }

  return { root: resolveRoot(root), db: db ?? DEFAULT_DB, full, json, limit, port, watch, positionals };
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

function withDb<T>(path: string, fn: (db: Database) => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const db = openDb(path);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function printTable(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    console.log("(no rows)");
    return;
  }
  const columns = Object.keys(rows[0] ?? {});
  const widths = columns.map((col) =>
    Math.max(col.length, ...rows.map((r) => String(r[col] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();

  console.log(line(columns));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const row of rows) {
    console.log(line(columns.map((col) => String(row[col] ?? ""))));
  }
}

function cmdIngest(flags: Flags): void {
  const started = Date.now();
  console.log(`reading ${flags.root}`);

  const summary = withDb(flags.db, (db) => {
    if (flags.full) resetDb(db);
    return ingest(db, {
      root: flags.root,
      full: flags.full,
      onProgress: (done, total) => {
        if (done % 25 === 0 || done === total) {
          process.stdout.write(`\r  scanned ${done}/${total} files`);
        }
      },
    });
  });

  process.stdout.write("\r".padEnd(40) + "\r");
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `indexed ${summary.filesChanged}/${summary.filesSeen} files in ${elapsed}s\n` +
      `  ${summary.sessions} sessions, ${summary.agents} agents, ` +
      `${summary.messages} new messages, ${summary.toolUses} new tool calls, ${summary.tasks} tasks`,
  );
  console.log(`  db: ${flags.db}`);
}

function cmdStats(flags: Flags): void {
  withDb(flags.db, (db) => {
    const totals = db
      .prepare(
        `SELECT (SELECT COUNT(DISTINCT repo_path) FROM sessions) AS projects,
                (SELECT COUNT(*) FROM sessions)  AS sessions,
                (SELECT COUNT(*) FROM agents)    AS agents,
                (SELECT COUNT(*) FROM messages)  AS messages,
                (SELECT COUNT(*) FROM tool_uses) AS tool_calls,
                (SELECT COUNT(*) FROM tasks)     AS tasks`,
      )
      .get() as Record<string, number>;

    if (flags.json) {
      console.log(JSON.stringify(totals, null, 2));
      return;
    }

    console.log("index");
    for (const [key, value] of Object.entries(totals)) {
      console.log(`  ${key.padEnd(11)} ${value}`);
    }

    console.log("\nprojects");
    const projectRows = db
      .prepare(
        `SELECT COALESCE(s.repo_path, p.repo_path, p.path, p.id) AS repo_path,
                COUNT(DISTINCT s.worktree) AS worktrees,
                COUNT(*) AS sessions,
                COALESCE(SUM(s.agent_count), 0) AS agents,
                COALESCE(SUM(s.message_count), 0) AS messages,
                MAX(COALESCE(s.ended_at, s.started_at)) AS last_active
           FROM sessions s
           LEFT JOIN projects p ON p.id = s.project_id
          GROUP BY 1
          ORDER BY last_active DESC NULLS LAST`,
      )
      .all() as { repo_path: string; [key: string]: unknown }[];

    printTable(
      projectRows.map(({ repo_path, ...rest }) => ({
        name: repo_path.split("/").pop() || repo_path,
        ...rest,
      })),
    );

    console.log("\nagent types");
    printTable(
      db
        .prepare(
          `SELECT COALESCE(agent_type, '(unknown)') AS agent_type,
                  COUNT(*) AS spawned,
                  MAX(spawn_depth) AS max_depth,
                  CAST(AVG(message_count) AS INT) AS avg_messages
             FROM agents GROUP BY agent_type ORDER BY spawned DESC`,
        )
        .all() as Record<string, unknown>[],
    );

    console.log("\nbusiest sessions");
    printTable(
      db
        .prepare(
          `SELECT substr(s.id, 1, 8) AS session,
                  COALESCE(s.title, '(untitled)') AS title,
                  p.name AS project,
                  s.agent_count AS agents,
                  s.message_count AS messages
             FROM sessions s JOIN projects p ON p.id = s.project_id
            ORDER BY s.agent_count DESC, s.message_count DESC
            LIMIT ?`,
        )
        .all(flags.limit) as Record<string, unknown>[],
    );

    const live = readLiveSessions(flags.root);
    console.log(`\nlive sessions (${live.length})`);
    printTable(
      live.map((s) => ({
        pid: s.pid,
        name: s.name ?? "",
        session: s.sessionId.slice(0, 8),
        cwd: s.cwd ?? "",
        started: s.startedAt?.toISOString() ?? "",
      })),
    );
  });
}

interface AgentRow {
  agent_id: string;
  parent_agent_id: string;
  agent_type: string | null;
  description: string | null;
  spawn_depth: number | null;
  message_count: number;
  output_tokens: number;
  started_at: string | null;
}

/** Prints the spawn tree for one session, proving the parent links resolve. */
function cmdTree(flags: Flags): void {
  const prefix = flags.positionals[1];
  if (prefix === undefined) {
    console.error("usage: tree <sessionId-or-prefix>");
    process.exitCode = 1;
    return;
  }

  withDb(flags.db, (db) => {
    const session = db
      .prepare(
        `SELECT s.id, s.title, s.cwd, s.git_branch, s.agent_count, s.message_count
           FROM sessions s WHERE s.id LIKE ? || '%' LIMIT 1`,
      )
      .get(prefix) as
      | { id: string; title: string | null; cwd: string | null; git_branch: string | null; agent_count: number; message_count: number }
      | null;

    if (session == null) {
      console.error(`no session matching "${prefix}"`);
      process.exitCode = 1;
      return;
    }

    console.log(`${session.title ?? "(untitled)"}`);
    console.log(`  session ${session.id}`);
    console.log(`  ${session.cwd ?? "?"} @ ${session.git_branch ?? "?"}`);
    console.log(`  ${session.message_count} messages, ${session.agent_count} agents\n`);

    const agents = db
      .prepare(
        `SELECT agent_id, parent_agent_id, agent_type, description, spawn_depth,
                message_count, output_tokens, started_at
           FROM agents WHERE session_id = ? ORDER BY started_at`,
      )
      .all(session.id) as unknown as AgentRow[];

    const byParent = new Map<string, AgentRow[]>();
    for (const agent of agents) {
      const siblings = byParent.get(agent.parent_agent_id) ?? [];
      siblings.push(agent);
      byParent.set(agent.parent_agent_id, siblings);
    }

    const walk = (parentId: string, indent: string): void => {
      const children = byParent.get(parentId) ?? [];
      children.forEach((agent, index) => {
        const last = index === children.length - 1;
        const label = agent.description ?? "(no description)";
        console.log(
          `${indent}${last ? "└─" : "├─"} [${agent.agent_type ?? "?"}] ${label} ` +
            `· ${agent.message_count} msgs · ${compact.format(agent.output_tokens)} out`,
        );
        walk(agent.agent_id, indent + (last ? "   " : "│  "));
      });
    };

    console.log("main thread");
    walk("", "");
  });
}

/**
 * Serves the API and the web UI. Unlike the other commands this keeps the
 * database handle open for the lifetime of the process, so it cannot go
 * through `withDb`.
 */
function cmdServe(flags: Flags): void {
  mkdirSync(dirname(flags.db), { recursive: true });
  const db = openDb(flags.db);

  // Catch up before serving, so the first paint is not stale by however long
  // the dashboard was last closed. A failure here is not fatal: serving the
  // index we already have beats refusing to start, and the watcher will retry.
  let caughtUp = 0;
  try {
    caughtUp = ingest(db, { root: flags.root }).messages;
  } catch (error) {
    console.warn(`catch-up ingest failed, serving the existing index: ${error}`);
  }

  const countRow = db.prepare("SELECT COUNT(*) AS sessions FROM sessions").get() as {
    sessions: number;
  };

  // The watcher pushes deltas to whoever is listening; the server subscribes on
  // behalf of every connected browser. Keeping the fan-out here means the server
  // never has to know a watcher exists, and `--no-watch` simply has no publisher.
  const listeners = new Set<(delta: IngestDelta) => void>();
  const watcher = flags.watch
    ? startWatching({
        db,
        root: flags.root,
        onChange: (delta) => {
          console.log(
            `+${delta.messages} msg in ${delta.sessions.length} session(s)` +
              (delta.newAgents.length > 0 ? `, ${delta.newAgents.length} new agent(s)` : ""),
          );
          for (const listener of listeners) listener(delta);
        },
      })
    : null;

  const server = startServer({
    db,
    root: flags.root,
    port: flags.port,
    subscribe:
      watcher === null
        ? undefined
        : (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
  });

  console.log(`dashboard  ${server.url}`);
  console.log(`index      ${flags.db} (${countRow.sessions} sessions)`);
  console.log(
    `watching   ${watcher === null ? "off (--no-watch)" : flags.root}` +
      (caughtUp > 0 ? ` · caught up ${caughtUp} messages` : ""),
  );

  const shutdown = () => {
    watcher?.stop();
    server.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function cmdQuery(flags: Flags): void {
  const sql = flags.positionals[1];
  if (sql === undefined) {
    console.error('usage: query "SELECT ..."');
    process.exitCode = 1;
    return;
  }
  withDb(flags.db, (db) => {
    const rows = db.prepare(sql).all() as Record<string, unknown>[];
    if (flags.json) console.log(JSON.stringify(rows, null, 2));
    else printTable(rows);
  });
}

function main(): void {
  const flags = parseFlags(process.argv.slice(2));
  const command = flags.positionals[0] ?? "ingest";

  switch (command) {
    case "ingest":
      cmdIngest(flags);
      break;
    case "stats":
      cmdStats(flags);
      break;
    case "tree":
      cmdTree(flags);
      break;
    case "serve":
      cmdServe(flags);
      break;
    case "query":
      cmdQuery(flags);
      break;
    default:
      console.error(
        `unknown command "${command}"\n\n` +
          "  ingest [--full]        read ~/.claude into the index\n" +
          "  serve  [--port <n>]    dashboard API and web UI, watching for changes\n" +
          "  stats  [--json]        overview of what is indexed\n" +
          "  tree   <sessionId>     spawn tree for one session\n" +
          '  query  "SELECT ..."    ad-hoc SQL\n\n' +
          "  --root <dir>  --db <file>  --limit <n>  --port <n>  --no-watch",
      );
      process.exitCode = 1;
  }
}

main();
