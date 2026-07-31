#!/bin/bash
set -euo pipefail

root=$(cd "$(dirname "$0")" && pwd)
profile=$(mktemp -d)
port=${NPAPI_PROBE_PORT:-49233}
output=${NPAPI_PROBE_OUTPUT:-"$root/evidence"}
browser=${QAXBROWSER:-/opt/qianxin.com/qaxbrowser/qaxbrowser}

cleanup() {
  if [[ -n "${browser_pid:-}" ]]; then
    kill "$browser_pid" 2>/dev/null || true
  fi
  rm -rf "$profile"
}
trap cleanup EXIT

"$browser" \
  --user-data-dir="$profile" \
  --no-first-run \
  --disable-gpu \
  --remote-debugging-port="$port" \
  --load-extension="$root" \
  about:blank >/tmp/wps-npapi-extension-host-browser.log 2>&1 &
browser_pid=$!

node "$root/capture.mjs" "http://127.0.0.1:$port" "$output"
