#!/usr/bin/env bun
/**
 * Builds a synthetic `~/.claude` and serves the dashboard over it.
 *
 * Two uses: trying tracetree without any Claude Code history of your own, and
 * regenerating the README screenshots from data that is safe to publish. The
 * shapes written here mirror the real transcript format closely enough to
 * exercise the reader — an `ai-title` line, messages split across lines that
 * share a request id, tool_use blocks answered by `tool_result` lines, a skill
 * whose instructions arrive detached from the call that loaded them, a
 * `subagents/` directory whose `meta.json` carries the spawn edge, and tasks.
 *
 *   bun run demo              generate, index and serve on :4300
 *   bun run demo --port 5000  somewhere else
 *   bun run demo --no-serve   just write the tree and the index
 */
// `Bun.write` creates the parent directories, which is most of what this
// script would otherwise need `mkdir -p` for. `rmSync` has no Bun equivalent
// that does not shell out.
import { rmSync } from "node:fs";
import { join } from "node:path";

import { openDb } from "../src/db.ts";
import { ingest } from "../src/ingest.ts";
import { startServer } from "../src/server.ts";

const HERE = join(import.meta.dirname, "..");
const ROOT = join(HERE, ".demo", "claude");
const DB = join(HERE, ".demo", "index.db");
const MODEL = "claude-opus-5";

const argv = Bun.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string, fallback: number) => {
  const i = argv.indexOf(`--${name}`);
  const raw = i === -1 ? undefined : argv[i + 1];
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// Timestamps run backwards from now, so relative times read naturally whenever
// the demo is run rather than drifting to "8 months ago".
let clock = Date.now() - 2 * 24 * 60 * 60 * 1000;
const at = (stepSeconds = 7) => new Date((clock += stepSeconds * 1000)).toISOString();

// Cleared up front, not at write time: the subagent metadata below is written
// eagerly while transcript lines are buffered, so wiping later deleted files
// this script had already produced.
rmSync(join(HERE, ".demo"), { recursive: true, force: true });

let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

interface Ctx {
  sessionId: string;
  cwd: string;
  branch: string;
  agentId?: string;
}

const envelope = (c: Ctx) => ({
  parentUuid: null,
  isSidechain: c.agentId !== undefined,
  userType: "external",
  entrypoint: "cli",
  cwd: c.cwd,
  sessionId: c.sessionId,
  version: "2.1.252",
  gitBranch: c.branch,
  ...(c.agentId === undefined ? {} : { agentId: c.agentId }),
});

const usage = (out: number, thinking = 0) => ({
  input_tokens: 3,
  cache_creation_input_tokens: 18_400,
  cache_read_input_tokens: 512_000,
  output_tokens: out,
  ...(thinking === 0 ? {} : { output_tokens_details: { thinking_tokens: thinking } }),
});

const files = new Map<string, string[]>();
const write = (file: string, line: unknown) => {
  const rows = files.get(file) ?? [];
  rows.push(JSON.stringify(line));
  files.set(file, rows);
};

const title = (file: string, c: Ctx, aiTitle: string) =>
  write(file, { ...envelope(c), type: "ai-title", uuid: uuid(), timestamp: at(0), aiTitle });

const user = (file: string, c: Ctx, text: string) =>
  write(file, {
    ...envelope(c),
    type: "user",
    uuid: uuid(),
    timestamp: at(30),
    message: { role: "user", content: [{ type: "text", text }] },
  });

const say = (file: string, c: Ctx, text: string, requestId: string, thinking = 0) =>
  write(file, {
    ...envelope(c),
    type: "assistant",
    uuid: uuid(),
    requestId,
    timestamp: at(9),
    message: {
      role: "assistant",
      model: MODEL,
      content: [{ type: "text", text }],
      usage: usage(420, thinking),
    },
  });

/** A tool call and the `user` line that answers it, as the transcript stores them. */
const call = (
  file: string,
  c: Ctx,
  requestId: string,
  name: string,
  input: unknown,
  result: string,
) => {
  const id = `toolu_${String(++counter).padStart(10, "0")}`;
  write(file, {
    ...envelope(c),
    type: "assistant",
    uuid: uuid(),
    requestId,
    timestamp: at(4),
    message: {
      role: "assistant",
      model: MODEL,
      content: [{ type: "tool_use", id, name, input }],
      usage: usage(180),
    },
  });
  write(file, {
    ...envelope(c),
    type: "user",
    uuid: uuid(),
    timestamp: at(6),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result }] },
  });
};

// ---------------------------------------------------------------------------
// The session worth looking at: prose, markdown, a skill, and a spawn tree.
// ---------------------------------------------------------------------------
const SESSION = "7c2f1a44-9b30-4d21-a6e8-15c0de99f001";
const CWD = "/home/dev/projects/orbit-api";
const SLUG = "-home-dev-projects-orbit-api";
const main: Ctx = { sessionId: SESSION, cwd: CWD, branch: "feat/rate-limiting" };
const file = join(ROOT, "projects", SLUG, `${SESSION}.jsonl`);

title(file, main, "Add rate limiting to the public API");
user(
  file,
  main,
  "We keep getting scraped on /v1/search. Can you add rate limiting to the public API?",
);
say(
  file,
  main,
  "Before writing anything I want to know what the traffic actually looks like — a limit picked from intuition is usually either useless or an outage.\n\nI'll fan out three agents: one to read how the API is structured, one to check what the gateway already supports, and one to look at real request volume.",
  "req_a1",
  310,
);
call(
  file,
  main,
  "req_a1",
  "Bash",
  {
    command: "rg -n 'router\\.(get|post)' src/routes | head -20",
    description: "List route handlers",
  },
  "src/routes/search.ts:12:router.get('/v1/search', handler)\nsrc/routes/docs.ts:8:router.get('/v1/docs', handler)",
);
call(
  file,
  main,
  "req_a2",
  "Agent",
  {
    description: "Map the API surface",
    subagent_type: "general-purpose",
    prompt: "Inventory every public route.",
  },
  "14 public routes; /v1/search is 82% of traffic.",
);
call(
  file,
  main,
  "req_a3",
  "Agent",
  {
    description: "Check gateway capabilities",
    subagent_type: "general-purpose",
    prompt: "What does the gateway support natively?",
  },
  "Envoy is already in front and ships local_ratelimit.",
);
call(
  file,
  main,
  "req_a4",
  "Agent",
  {
    description: "Measure request volume",
    subagent_type: "Explore",
    prompt: "Pull 30 days of request counts.",
  },
  "p50 4 req/min per key, p99 220 req/min, one key at 40k/day.",
);
say(
  file,
  main,
  "All three are back, and the answer changed because of what they found.\n\n## What the traffic says\n\n| measure | value |\n|---|---|\n| p50 per key | 4 req/min |\n| p99 per key | 220 req/min |\n| worst key | 40,000/day |\n\nThat single key is 82% of `/v1/search` traffic on its own. A global limit would punish everyone for one client, so this wants a **per-key** limit, not a per-route one.\n\n## Where it belongs\n\nEnvoy already sits in front and ships `local_ratelimit`, so the limit belongs in the gateway rather than in application code — it costs no request latency and survives a process restart.\n\n```yaml\ntoken_bucket:\n  max_tokens: 300\n  fill_interval: 60s\n```\n\n300/min leaves the p99 client untouched and still cuts the outlier by 95%.",
  "req_a5",
  640,
);
user(file, main, "That works. Ship it behind a flag so we can back it out quickly.");

// A skill: the call carries a stub, and the instructions arrive as their own line.
say(file, main, "Flagging it and opening the PR with the `file-pr` skill.", "req_a6", 120);
call(file, main, "req_a6", "Skill", { skill: "file-pr" }, "Launching skill: file-pr");
user(
  file,
  main,
  "Base directory for this skill: /home/dev/.claude/skills/file-pr\n\n# File PR\n\nBefore filing, check whether a PR for this branch already exists. Review the diff locally against the base branch to make sure its contents match the goal.\n\nPR titles usually become commit messages, so follow the repository's conventions. Prefer a concise title that explains why the change matters.\n\nKeep the description to what a reviewer needs: what changed, why, and how it was verified.",
);
say(
  file,
  main,
  "Opened as **#412**, limit logging-only for the first 24 hours so you can see who *would* have been throttled before anything actually is.",
  "req_a7",
  95,
);

// The three subagents, one of which nests a fourth.
const agents = [
  {
    id: "a1f0c3e77b21d4a90",
    type: "general-purpose",
    desc: "Map the API surface",
    work: [
      ["rg -c 'router\\.' src/routes/*.ts", "search.ts:1\ndocs.ts:1\nkeys.ts:3"],
      ["cat src/routes/search.ts", "export const handler = async (req, res) => { /* ... */ }"],
    ],
  },
  {
    id: "b2e4d5a11c37f6b80",
    type: "general-purpose",
    desc: "Check gateway capabilities",
    work: [["envoy --version", "envoy version 1.29.1"]],
  },
  {
    id: "c3d5e6b22a4807c91",
    type: "Explore",
    desc: "Measure request volume",
    work: [["bq query 'select count(*) from requests'", "rows: 1\ntotal: 2,481,309"]],
  },
  {
    id: "d4c6f7a33b5918d02",
    type: "general-purpose",
    desc: "Break down the outlier key",
    parent: "c3d5e6b22a4807c91",
    work: [["bq query 'select key, count(*) ...'", "key_9f2a: 40,113\nkey_1b77: 3,004"]],
  },
] as const;

for (const agent of agents) {
  const dir = join(ROOT, "projects", SLUG, SESSION, "subagents");
  await Bun.write(
    join(dir, `agent-${agent.id}.meta.json`),
    JSON.stringify({
      agentType: agent.type,
      description: agent.desc,
      toolUseId: `toolu_${agent.id.slice(0, 10)}`,
      ...("parent" in agent ? { parentAgentId: agent.parent, spawnDepth: 2 } : { spawnDepth: 1 }),
    }),
  );

  const af = join(dir, `agent-${agent.id}.jsonl`);
  const ctx: Ctx = { ...main, agentId: agent.id };
  const req = `req_${agent.id.slice(0, 4)}`;
  user(af, ctx, agent.desc);
  say(af, ctx, `Starting on: ${agent.desc.toLowerCase()}.`, req, 90);
  for (const [command, out] of agent.work) {
    call(af, ctx, req, "Bash", { command, description: agent.desc }, out);
  }
  say(af, ctx, `Done. ${agent.desc} complete.`, `${req}b`, 40);
}

// ---------------------------------------------------------------------------
// Enough other projects that the sidebar and overview are not a single row.
// ---------------------------------------------------------------------------
/** Distinct, as real session ids are; a shared prefix makes `tree` ambiguous. */
const OTHER_SESSION_IDS = [
  "3e9b7c05-41d8-4a62-9f13-2b70ce4188aa",
  "b81d4f2a-6c07-4e95-8d31-77a0fe22bb64",
  "5f0a2d63-9e18-4b47-a052-c31d84ff90e7",
  "c47e8b19-2035-4d6a-91cf-6ea25b73d012",
  "9a13f6d8-7b40-4c29-83e5-1fd06ac45b93",
];

const others = [
  [
    "-home-dev-projects-web-client",
    "/home/dev/projects/web-client",
    "Fix hydration mismatch on the dashboard",
    "main",
  ],
  [
    "-home-dev-projects-web-client",
    "/home/dev/projects/web-client",
    "Migrate the table to virtualised rows",
    "perf/virtual-rows",
  ],
  ["-home-dev-projects-billing", "/home/dev/projects/billing", "Reconcile Stripe webhooks", "main"],
  [
    "-home-dev-projects-infra",
    "/home/dev/projects/infra",
    "Rotate the staging certificates",
    "main",
  ],
  [
    "-home-dev-tools-changelog",
    "/home/dev/tools/changelog",
    "Generate release notes from commits",
    "main",
  ],
] as const;

others.forEach(([slug, cwd, sessionTitle, branch], i) => {
  const sid = OTHER_SESSION_IDS[i] ?? `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  const ctx: Ctx = { sessionId: sid, cwd, branch };
  const of = join(ROOT, "projects", slug, `${sid}.jsonl`);
  title(of, ctx, sessionTitle);
  user(of, ctx, `${sessionTitle}?`);
  say(of, ctx, "Looking at it now.", `req_o${i}`, 60);
  call(
    of,
    ctx,
    `req_o${i}`,
    "Read",
    { file_path: `${cwd}/src/index.ts` },
    "export function main() {}",
  );
  say(of, ctx, `Done — ${sessionTitle.toLowerCase()} is handled.`, `req_o${i}b`, 45);
});

// ---------------------------------------------------------------------------
// Write it all out.
// ---------------------------------------------------------------------------
for (const [path, rows] of files) {
  await Bun.write(path, `${rows.join("\n")}\n`);
}

const tasks = [
  {
    id: "1",
    subject: "Measure current request volume",
    status: "completed",
    activeForm: "Measuring request volume",
  },
  {
    id: "2",
    subject: "Pick a per-key limit from the p99",
    status: "completed",
    activeForm: "Choosing the limit",
  },
  {
    id: "3",
    subject: "Roll out logging-only for 24h",
    status: "in_progress",
    activeForm: "Rolling out behind a flag",
  },
];
const taskDir = join(ROOT, "tasks", SESSION);
for (const task of tasks) {
  await Bun.write(
    join(taskDir, `${task.id}.json`),
    JSON.stringify({ ...task, blocks: [], blockedBy: [] }, null, 2),
  );
}

console.log(`wrote ${files.size} transcripts to ${ROOT}`);

const db = openDb(DB);
const summary = ingest(db, { root: ROOT, full: true });
console.log(
  `indexed ${summary.sessions} sessions, ${summary.agents} agents, ${summary.messages} messages`,
);

if (flag("no-serve")) {
  db.close();
  console.log(`\nServe it with:\n  bun run serve --root ${ROOT} --db ${DB}`);
} else {
  const server = startServer({ db, root: ROOT, port: value("port", 4300) });
  console.log(`\ndemo dashboard  ${server.url}`);
  console.log(`  the session to look at is "Add rate limiting to the public API"`);
}
