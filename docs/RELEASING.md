# Releasing

Releases are cut by tagging. `.github/workflows/release.yml` does the rest:
checks, publish to npm, and the GitHub release.

## One-time setup

npm publishes with **trusted publishing** (OIDC), so there is no `NPM_TOKEN` in
this repository and nothing to rotate. Provenance is attached automatically.

On npmjs.com, under the `tracetree` package settings, add a trusted publisher:

| field | value |
| --- | --- |
| Repository | `viktoravelino/tracetree` |
| Workflow | `release.yml` |
| Environment | *(leave empty)* |

The binding is to the workflow **filename**, so renaming `release.yml` breaks
publishing until the setting is updated.

The very first publish cannot use OIDC, because the package does not exist yet
and so has no trusted-publisher settings. `0.1.0` was published by hand:

```bash
npm publish --provenance=false --otp=<code>
```

Both flags are needed only for that bootstrap publish. `--provenance=false`
overrides `publishConfig`, because provenance is generated from a CI runner's
OIDC token and cannot be produced on a laptop; the workflow attaches it to every
release after this one. `--otp` is the account's 2FA code, which the registry
demands for a publish from outside CI and not for a trusted-publisher one.

Then add the trusted publisher above, and every release after that is a tag.

Once it is configured, switch *Publishing access* to **require two-factor
authentication and disallow bypass 2FA tokens**. Trusted publishing works under
the strictest setting -- there is no token in this repository for that rule to
break -- and npm is restricting 2FA-bypassing tokens for direct publishing from
January 2027 anyway.

## Cutting a release

```bash
bun run release patch          # or minor / major / an explicit 0.2.0-rc.1
```

That is the whole thing. `scripts/release.sh` sets the version, runs the checks
the workflow will run, commits, tags, and pushes both; the tag is what
publishes.

It runs the checks *after* writing the version, so what gets verified is the
tree that gets tagged — `scripts/verify-package.sh` in particular, which packs,
installs into an empty project and serves it. Packaging is where the last real
bug was, and a checkout cannot see that class of bug because it has every
devDependency installed.

Before touching anything it refuses what cannot be undone: a branch other than
main, a dirty or stale checkout, a tag that already exists locally or on origin,
and a version already on npm. If a check fails, a trap puts `package.json` back.

The workflow independently refuses to publish if the tag disagrees with
`package.json`. A tag containing a hyphen (`v0.2.0-rc.1`) is marked as a
prerelease on GitHub.

It pushes straight to main, which the ruleset permits for a repository admin;
GitHub prints the rules it bypassed, which is informational, not a failure.

## Rehearsing

```bash
DRY_RUN=1 bun run release patch
```

Runs every check against the bumped version, restores `package.json`, and prints
what it would have committed, tagged and pushed. Nothing leaves the machine.

There is also *Actions* → *Release* → *Run workflow* with **dry run** ticked,
which runs the workflow's own checks and `npm publish --dry-run`. Note that it
does not exercise OIDC, so it cannot tell you whether trusted publishing is
correctly configured — only a real publish does that.

## If a release half-fails

The publish step is skipped when that version is already on npm, so re-running
the workflow after a failure later in the job is safe and will not error on the
publish. It will not overwrite what is already published — npm forbids that, and
so the fix for a bad release is always a new version, never a re-push of a tag.

## What ships

`files` in `package.json` decides: `src`, `web` (including the generated
`web/app.css`), `scripts/demo.ts`, `tsconfig.json`, `README.md`, `LICENSE`.

TypeScript ships unbuilt on purpose. tracetree needs Bun at runtime anyway —
`bun:sqlite`, `Bun.serve`'s HTML imports — so there is nothing to gain from
compiling it to JavaScript that Node still could not run. `tsconfig.json` is
included because Bun reads it for the `@/*` path alias.

Check what a publish would contain without publishing:

```bash
npm pack --dry-run
```
