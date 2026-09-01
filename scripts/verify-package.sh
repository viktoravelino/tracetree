#!/usr/bin/env bash
# Installs the packed tarball the way a user would -- into an empty project that
# has none of this repo's devDependencies -- and checks that the dashboard
# actually serves a styled page.
#
# This exists because a checkout cannot catch a dependency in the wrong section:
# `bun build web/index.html` succeeds in the repo whether tailwindcss is a
# dependency or a devDependency, and only an install elsewhere tells them apart.
# It is the check that would have stopped 0.1.0 shipping with an unstyled 500.
#
# Runs locally too: scripts/verify-package.sh
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PORT=${PORT:-4457}
PROBE=$(mktemp -d)
CLAUDE="$PROBE/claude"
server=""

cleanup() {
  [[ -n $server ]] && kill "$server" 2>/dev/null
  rm -rf "$PROBE"
}
trap cleanup EXIT

cd "$ROOT"
tgz=$(npm pack --silent)
trap 'rm -f "$ROOT/$tgz"; cleanup' EXIT

mkdir -p "$CLAUDE/projects"
cd "$PROBE"
echo '{"name":"probe","private":true}' >package.json
bun add "$ROOT/$tgz"

cli=$PROBE/node_modules/.bin/tracetree

# Asking for help must succeed, not print "unknown command" and exit 1.
"$cli" --help >/dev/null

# --version reads package.json relative to the install, so it is only really
# exercised from outside a checkout.
installed=$("$cli" --version)
declared=$(node -p "require('$ROOT/package.json').version")
[[ $installed == "$declared" ]] || {
  echo "::error::installed --version says $installed, package.json says $declared"
  exit 1
}

"$cli" serve --port "$PORT" --root "$CLAUDE" --db "$PROBE/index.db" --no-watch >"$PROBE/serve.log" 2>&1 &
server=$!

for _ in $(seq 30); do
  [[ $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/") == 200 ]] && break
  sleep 1
done

status=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")
if [[ $status != 200 ]]; then
  echo "::error::the dashboard returned $status"
  cat "$PROBE/serve.log"
  exit 1
fi

css=$(curl -s "http://127.0.0.1:$PORT/" | grep -oE 'href="[^"]*\.css"' | head -1 | sed 's/href="//;s/"//')
if [[ -z $css ]]; then
  echo "::error::the page links no stylesheet"
  cat "$PROBE/serve.log"
  exit 1
fi

# An unresolved `@import "tailwindcss"` makes the bundle fail and the page 500;
# a resolved one is tens of kilobytes. The threshold only has to tell those two
# apart.
bytes=$(curl -s -o /dev/null -w '%{size_download}' "http://127.0.0.1:$PORT$css")
if ((bytes < 10000)); then
  echo "::error::$css is $bytes bytes; tailwind did not resolve"
  cat "$PROBE/serve.log"
  exit 1
fi

[[ $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/overview") == 200 ]] ||
  { echo "::error::/api/overview did not answer"; exit 1; }

echo "packaged install serves 200, ${bytes}B of css, and a live api"
