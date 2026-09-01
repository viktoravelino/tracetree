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
and so has no trusted-publisher settings. Publish `0.1.0` once by hand:

```bash
npm login
npm publish            # publishConfig already sets access: public
```

Then add the trusted publisher above, and every release after that is a tag.

## Cutting a release

```bash
npm version patch      # or minor / major — writes package.json and tags
git push --follow-tags
```

The workflow refuses to publish if the tag disagrees with `package.json`, so
these two must move together; `npm version` does that in one step.

A tag containing a hyphen (`v0.2.0-rc.1`) is marked as a prerelease on GitHub.

## Rehearsing

*Actions* → *Release* → *Run workflow*, with **dry run** ticked. It runs every
check and `npm publish --dry-run`, publishing nothing and creating no release.

## If a release half-fails

The publish step is skipped when that version is already on npm, so re-running
the workflow after a failure later in the job is safe and will not error on the
publish. It will not overwrite what is already published — npm forbids that, and
so the fix for a bad release is always a new version, never a re-push of a tag.

## What ships

`files` in `package.json` decides: `src`, `web`, `scripts`, `bunfig.toml`,
`components.json`, `tsconfig.json`, `README.md`, `LICENSE`.

TypeScript ships unbuilt on purpose. tracetree needs Bun at runtime anyway —
`bun:sqlite`, `Bun.serve`'s HTML imports — so there is nothing to gain from
compiling it to JavaScript that Node still could not run. `tsconfig.json` is
included because Bun reads it for the `@/*` path alias.

Check what a publish would contain without publishing:

```bash
npm pack --dry-run
```
