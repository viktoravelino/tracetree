# Security

## Threat model, in three sentences

tracetree reads the transcripts Claude Code has already written under `~/.claude`
and serves them over plain HTTP with no authentication, so anything that can
reach the port can read every session in the index — every message, every tool
call and its output, every file path, and every screenshot you pasted. It
therefore binds loopback (`127.0.0.1`) and nothing else unless you pass `--host`,
which is the whole of the access control: there is no login, no token, and no
per-project scoping. It never writes to `~/.claude`; the index it builds is
derived data that can be deleted and rebuilt at any time.

## What it protects

- The server binds `127.0.0.1` by default, so the dashboard is not reachable
  from your network. Exposing it is a deliberate act (`--host 0.0.0.0`).
- `~/.claude` is opened read-only in effect: the reader only ever reads
  transcripts, and no code path writes to that tree.
- The web UI renders model output as markdown with `rehype-sanitize` and
  without `rehype-raw`, so raw HTML in a transcript is never parsed into the
  page, and `javascript:` links are neutralised twice over.
- Attached images are served from their own route with an immutable cache
  header and are never executed.

## What it does not protect

- **Anything that reaches the port reads everything.** If you pass `--host`, or
  forward the port, or run it on a shared machine, you have published your
  transcripts to whoever can connect. There is no authentication to add on top.
- **The index is as sensitive as the transcripts.** `data/index.db` contains the
  full text of every message and the bytes of every attached image. It is
  gitignored, but it is not encrypted and it is a single file that is easy to
  copy or back up by accident.
- **Transcripts contain whatever your sessions contained** — secrets pasted into
  a prompt, tokens echoed by a command, private source. tracetree neither
  redacts nor detects these.
- The demo data (`bun run demo`) is synthetic and safe to publish; your real
  index is not.

## How this repository is configured

Relevant if you are reading the source to decide whether to trust the package:

- Secret scanning and push protection are on, so a credential cannot be pushed
  here without being blocked at the point of push.
- Dependabot alerts and security updates are on, and version updates arrive
  monthly under `.github/dependabot.yml`.
- `main` requires a pull request with CI green -- typecheck, lint, and the two
  end-to-end jobs -- before anything merges.
- `v*` tags cannot be deleted or moved once pushed. A published npm version can
  never be replaced, so the tag it was built from stays put too.
- Releases publish through npm trusted publishing (OIDC), so no npm token exists
  in this repository to leak, and every release after 0.1.0 carries provenance.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository (_Security_ →
_Report a vulnerability_). Please do not open a public issue for security
problems.

## Supported versions

The latest release only. Fixes ship as a new patch release rather than as
backports.
