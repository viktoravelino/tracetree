# Contributing

Thanks for looking. This is a small project with a small surface, so the bar is
mostly: does it work when installed, and is it still simple afterwards.

## You need Bun

Not Node. `bun:sqlite`, `Bun.serve`'s HTML imports and native TypeScript
execution are all load-bearing, which is why the package ships TypeScript
unbuilt — there would be nothing to gain from compiling it to JavaScript that
Node still could not run.

```bash
git clone https://github.com/viktoravelino/tracetree
cd tracetree
bun install
bun run demo          # synthetic ~/.claude, indexed and served on :4300
```

`bun run demo` is the way to work on this. It writes a fake transcript tree, so
you can develop against a populated dashboard without pointing anything at your
own sessions.

## Before you open a pull request

```bash
bun run typecheck
bun run lint                 # oxlint; bun run format applies oxfmt
bun run demo --no-serve
scripts/verify-package.sh    # if you touched dependencies or the files list
```

The last one packs the tarball, installs it into an empty project and serves it.
Run it for anything that touches `package.json`, `bunfig.toml` or `web/styles.css`:
a checkout has every devDependency installed, so it physically cannot show you a
runtime dependency filed in the wrong section. That mistake shipped once.

## Opening the pull request

`main` requires a pull request with `typecheck`, `lint`, `smoke` and `package`
green. **Open it and stop there — the maintainer merges.** Don't merge your own
PR and don't enable auto-merge, even if you have the ability to.

Commit subjects are `type(scope): summary` in the imperative — `fix(server):`,
`docs(releasing):`. Use the body to explain why when it isn't obvious from the
diff. No AI attribution and no emoji.

## Things that will be sent back

- **Committing real transcript data.** `data/` and `.demo/` are gitignored and
  must stay that way. Everything demonstrable comes from `bun run demo`.
- **Changing the default bind address.** The server has no authentication at
  all, so `127.0.0.1` is the entire access control. `--host` exists for people
  who mean it.
- **Adding `rehype-raw`.** Transcripts contain arbitrary model output; raw HTML
  is never parsed into the page.
- **A change that requires re-reading every transcript.** Ingest is incremental
  by byte offset and needs to stay that way.

## Reporting a vulnerability

Not here — see [SECURITY.md](SECURITY.md). Use GitHub's private vulnerability
reporting rather than a public issue.

## More detail

[AGENTS.md](AGENTS.md) has the conventions and invariants in full, and
[docs/RELEASING.md](docs/RELEASING.md) covers how a release is cut.
