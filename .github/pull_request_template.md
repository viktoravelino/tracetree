<!-- What changed and why. The body is the commit message a reader gets later. -->

## What this changes

## Why

## Checks

- [ ] `bun run typecheck`
- [ ] `bun run lint`
- [ ] `bun run demo --no-serve`
- [ ] `scripts/verify-package.sh` — required if this touches `package.json`, `bunfig.toml` or `web/styles.css`, because a checkout cannot catch a runtime dependency filed as a devDependency

<!--
Open it and stop here: the maintainer merges. Please don't merge your own PR or
enable auto-merge.
-->
