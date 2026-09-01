// Daily metrics snapshot: GitHub traffic, stars and npm downloads, merged into
// date-keyed JSON files on the `metrics` branch. GitHub's traffic API only
// keeps 14 days — this job is what turns that rolling window into history, and
// the history only starts from the first run, so a day without it is gone.
//
// Dependency-free, Node >= 22. Sections skip or fail independently; the run
// fails only if every section failed.
//
// Env: REPO (owner/name)            required
//      DATA_DIR                     where the JSON lives (default ./data)
//      METRICS_PAT | GITHUB_TOKEN   traffic needs a token with push access;
//                                   the Actions installation token 403s on it
//      NPM_PACKAGE                  npm package name (skip npm when unset)

/* oxlint-disable no-console -- console.error is this script's logging; CI reads it */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const repo = process.env.REPO;
if (!repo) {
  console.error("REPO is required (owner/name)");
  process.exit(1);
}
const dataDir = process.env.DATA_DIR ?? "./data";
const ghToken = process.env.METRICS_PAT || process.env.GITHUB_TOKEN;
const today = new Date().toISOString().slice(0, 10);

await mkdir(dataDir, { recursive: true });

const readJson = async (name) => {
  try {
    return JSON.parse(await readFile(join(dataDir, name), "utf8"));
  } catch {
    return {};
  }
};

// Date-keyed maps merge by overwrite: every source revises its most recent
// (still partial) day, so the newest snapshot of a date always wins.
const writeJson = (name, obj) =>
  writeFile(
    join(dataDir, name),
    JSON.stringify(Object.fromEntries(Object.entries(obj).toSorted()), null, 2) + "\n",
  );

const cell = (v) => v ?? "–";

const get = async (url, headers) => {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
};

let ok = 0;
const failures = [];
const skipped = [];
// A skip is neither a success nor a failure: it does not count toward `ok`, so
// a run where every section skipped still fails rather than silently recording
// nothing.
const skip = (name, why) => {
  skipped.push(name);
  console.error(`${name}: ${why}, skipping`);
};
const section = async (name, fn) => {
  try {
    await fn();
    ok++;
  } catch (err) {
    if (err instanceof Skip) return skip(name, err.message);
    failures.push(name);
    console.error(`${name}: ${err.message}`);
  }
};
class Skip extends Error {}

// --- GitHub: traffic views/clones per day, plus repo counts ---------------
const gh = (path) =>
  get(`https://api.github.com/repos/${repo}${path}`, {
    authorization: `Bearer ${ghToken}`,
    accept: "application/vnd.github+json",
  });

await section("github traffic", async () => {
  const github = await readJson("github.json");
  github.views ??= {};
  github.clones ??= {};
  github.repo ??= {};
  const [views, clones, info] = await Promise.all([
    gh("/traffic/views?per=day"),
    gh("/traffic/clones?per=day"),
    gh(""),
  ]);
  for (const v of views.views) {
    github.views[v.timestamp.slice(0, 10)] = { count: v.count, uniques: v.uniques };
  }
  for (const c of clones.clones) {
    github.clones[c.timestamp.slice(0, 10)] = { count: c.count, uniques: c.uniques };
  }
  github.repo[today] = {
    stars: info.stargazers_count,
    forks: info.forks_count,
    watchers: info.subscribers_count,
  };
  await writeJson("github.json", github);
});

// Referrers and paths are top-N lists rather than per-day series, so they are
// appended as one line per run instead of merged by date.
await section("github referrers", async () => {
  const [referrers, paths] = await Promise.all([
    gh("/traffic/popular/referrers"),
    gh("/traffic/popular/paths"),
  ]);
  const name = join(dataDir, "referrers.ndjson");
  const existing = await readFile(name, "utf8").catch(() => "");
  await writeFile(name, existing + JSON.stringify({ date: today, referrers, paths }) + "\n");
});

// --- npm: daily downloads (last month each run; the merge covers gaps) -----
await section("npm", async () => {
  const pkg = process.env.NPM_PACKAGE;
  if (!pkg) throw new Skip("NPM_PACKAGE unset");
  const npm = await readJson("npm.json");
  const url = `https://api.npmjs.org/downloads/range/last-month/${pkg}`;
  // The downloads API 404s for a package with no rollup yet, which is what a
  // just-published one looks like for its first day. That is an absence of
  // data, not a failure to fetch it.
  const res = await fetch(url);
  if (res.status === 404) throw new Skip("no downloads recorded yet");
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const range = await res.json();
  for (const d of range.downloads) npm[d.day] = d.downloads;
  await writeJson("npm.json", npm);
});

if (ok === 0) {
  console.error(`nothing was recorded: ${[...failures, ...skipped].join(", ")}`);
  process.exit(1);
}
console.error(
  `done: ${ok} section(s) ok` +
    (failures.length ? `, failed: ${failures.join(", ")}` : "") +
    (skipped.length ? `, skipped: ${skipped.join(", ")}` : ""),
);

// --- Actions job summary: the last few days at a glance --------------------
if (process.env.GITHUB_STEP_SUMMARY) {
  const [github, npm] = await Promise.all([readJson("github.json"), readJson("npm.json")]);
  const days = [...Array(4)].map((_, i) =>
    new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10),
  );
  const rows = days.map((d) => {
    const v = github.views?.[d];
    const c = github.clones?.[d];
    return `| ${d} | ${cell(v && `${v.count} (${v.uniques})`)} | ${cell(
      c && `${c.count} (${c.uniques})`,
    )} | ${cell(npm[d])} |`;
  });
  const repoNow = github.repo?.[today];
  const summary = [
    `## Metrics · ${today}`,
    "",
    "| date | gh views (uniq) | gh clones (uniq) | npm downloads |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    repoNow
      ? `⭐ ${repoNow.stars} stars · ${repoNow.forks} forks · ${repoNow.watchers} watchers`
      : "",
    failures.length ? `\n> ⚠️ failed sections: ${failures.join(", ")}` : "",
  ].join("\n");
  const { appendFile } = await import("node:fs/promises");
  await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
}
