#!/bin/bash
set -euo pipefail

root=$(cd "$(dirname "$0")" && pwd)
profile=$(mktemp -d)
state=$(mktemp -d)
port=${AUTH_OA_CDP_PORT:-49235}
output=${AUTH_OA_OUTPUT:-"$root/evidence"}
browser=${QAXBROWSER:-/opt/qianxin.com/qaxbrowser/qaxbrowser}

cleanup() {
  if [[ -n "${browser_pid:-}" ]]; then
    kill "$browser_pid" 2>/dev/null || true
    wait "$browser_pid" 2>/dev/null || true
  fi
  if [[ -n "${server_pid:-}" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  sleep 1
  rm -rf -- "$profile" "$state"
}
trap cleanup EXIT

rm -rf "$output"
mkdir -p "$output"

AUTH_OA_STATE="$state" python3 "$root/demo_oa.py" >"$output/demo-oa.log" 2>&1 &
server_pid=$!

for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:49234/oa/login" >/dev/null; then
    break
  fi
  sleep 0.25
done

"$browser" \
  --user-data-dir="$profile" \
  --no-first-run \
  --disable-gpu \
  --remote-debugging-port="$port" \
  --load-extension="$root" \
  about:blank >"$output/qaxbrowser.log" 2>&1 &
browser_pid=$!

node "$root/capture.mjs" "http://127.0.0.1:$port" "$output" | tee "$output/console-result.json"
