#!/bin/bash
set -euo pipefail

root=$(cd "$(dirname "$0")" && pwd)
profile=$(mktemp -d)
state=$(mktemp -d)
mode=${1:-interactive}
cdp_port=${GATEWAY_FLOW_CDP_PORT:-49241}
output=${GATEWAY_FLOW_OUTPUT:-"$root/evidence"}
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

GATEWAY_FLOW_STATE="$state" python3 "$root/demo_oa.py" >"$state/demo-oa.log" 2>&1 &
server_pid=$!
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:49240/oa/session/start" >/dev/null; then break; fi
  sleep 0.25
done

if [[ "$mode" == "--capture" ]]; then
  rm -rf -- "$output"
  mkdir -p "$output"
  "$browser" --user-data-dir="$profile" --no-first-run --disable-gpu \
    --remote-debugging-port="$cdp_port" --load-extension="$root/extension" about:blank >"$output/qaxbrowser.log" 2>&1 &
  browser_pid=$!
  node "$root/capture.mjs" "http://127.0.0.1:$cdp_port" "$output" | tee "$output/console-result.json"
  install -m 0644 "$state/demo-oa.log" "$output/demo-oa.log"
  exit
fi

if [[ "$mode" != "interactive" ]]; then
  printf 'Usage: %s [--capture]\n' "$0" >&2
  exit 2
fi

printf 'Demo OA: http://127.0.0.1:49240/oa/session/start\n'
printf 'Close Qaxbrowser to stop the prototype.\n'
"$browser" --user-data-dir="$profile" --no-first-run --disable-gpu \
  --load-extension="$root/extension" "http://127.0.0.1:49240/oa/session/start" >"$state/qaxbrowser.log" 2>&1 &
browser_pid=$!
wait "$browser_pid"
