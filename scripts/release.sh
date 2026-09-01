#!/usr/bin/env bash
# Cuts a release in one move:
#
#   scripts/release.sh patch          0.1.1 -> 0.1.2
#   scripts/release.sh minor|major
#   scripts/release.sh 0.2.0-rc.1     an explicit version; a hyphen makes it a
#                                     prerelease on GitHub and goes to `next`
#
# It sets the version, runs the checks the release workflow will run, commits,
# tags and pushes both. The tag is what publishes: .github/workflows/release.yml
# picks it up, re-runs everything, and publishes through npm trusted publishing.
#
# The checks run *after* the version is written, so what is verified is the tree
# that will be tagged. That ordering is the point -- scripts/verify-package.sh
# installs the packed tarball into an empty project and serves it, which is the
# check that caught tailwind being a devDependency before 0.1.0 shipped broken.
#
# This pushes straight to main, which the ruleset permits for a repository admin.
# Everyone else opens a pull request.
#
# DRY_RUN=1 runs every check against the bumped version, then restores the tree
# and prints what it would have done. Nothing is committed, tagged or pushed.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PKG="$ROOT/package.json"
SEMVER='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
case ${DRY_RUN:-0} in 1 | true | yes) DRY=1 ;; *) DRY=0 ;; esac

die() { echo "release: $*" >&2; exit 1; }
run() { if [[ $DRY == 1 ]]; then echo "dry-run: $*"; else "$@"; fi; }
current_version() { node -p "require('$PKG').version"; }
name() { node -p "require('$PKG').name"; }

arg=${1:-}
[[ -n $arg ]] || { sed -n '2,9p' "$0"; exit 2; }

# --- what to release ------------------------------------------------------
cur=$(current_version)
case $arg in
  patch | minor | major)
    IFS=. read -r ma mi pa <<<"${cur%%-*}"
    case $arg in
      patch) next=$ma.$mi.$((pa + 1)) ;;
      minor) next=$ma.$((mi + 1)).0 ;;
      major) next=$((ma + 1)).0.0 ;;
    esac
    ;;
  *)
    [[ $arg =~ $SEMVER ]] || die "'$arg' is neither a semver version nor patch/minor/major"
    next=$arg
    ;;
esac

# --- refuse the releases that cannot work ---------------------------------
# Each of these is unrecoverable in a different way: a wrong branch or a stale
# main tags the wrong commit, and npm never lets a published version be replaced.
[[ $(git -C "$ROOT" branch --show-current) == main ]] || die "run this from main"
[[ -z $(git -C "$ROOT" status --porcelain) ]] || die "the working tree is not clean"
git -C "$ROOT" fetch -q origin main
[[ $(git -C "$ROOT" rev-parse HEAD) == $(git -C "$ROOT" rev-parse origin/main) ]] ||
  die "main is behind origin; git pull first"

[[ $next != "$cur" ]] || die "already $cur"
git -C "$ROOT" rev-parse -q --verify "refs/tags/v$next" >/dev/null && die "tag v$next exists locally"
[[ -z $(git -C "$ROOT" ls-remote --tags origin "refs/tags/v$next") ]] || die "tag v$next exists on origin"
npm view "$(name)@$next" version >/dev/null 2>&1 && die "$(name)@$next is already on npm"

echo "release: $cur -> $next"

# However this exits, main goes back how it was found. A failing check must not
# leave a bumped version sitting in the working tree.
restore() { git -C "$ROOT" checkout -q -- "$PKG"; }
trap 'restore; echo "release: restored package.json; nothing was committed" >&2' ERR
if [[ $DRY == 1 ]]; then
  trap 'restore; echo "dry-run: restored package.json"' EXIT
fi

cd "$ROOT"
npm pkg set version="$next"

# --- the checks, against the version being tagged -------------------------
bun install --frozen-lockfile >/dev/null
bun run typecheck
bun run lint
bun run demo --no-serve >/dev/null
scripts/verify-package.sh >/dev/null
echo "packaged install verified"

# --- ship -----------------------------------------------------------------
trap - ERR
run git -C "$ROOT" add package.json
run git -C "$ROOT" commit -q -m "release: $next"
run git -C "$ROOT" tag -a "v$next" -m "$(name) $next"
run git -C "$ROOT" push -q --follow-tags origin main

if [[ $DRY == 1 ]]; then
  echo "dry-run: v$next would publish $(name)@$next"
else
  echo "tagged v$next — the release workflow is publishing $(name)@$next:"
  echo "  gh run watch \$(gh run list --workflow release.yml --limit 1 --json databaseId -q '.[0].databaseId')"
fi
