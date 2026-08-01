#!/bin/bash
set -euo pipefail

root=$(cd "$(dirname "$0")" && pwd)
profile=$(mktemp -d)
state=$(mktemp -d)
mode=${1:-interactive}
cdp_port=${IDENTITY_GATE_CDP_PORT:-49251}
output=${IDENTITY_GATE_OUTPUT:-"$root/evidence"}
browser=${QAXBROWSER:-/opt/qianxin.com/qaxbrowser/qaxbrowser}

cleanup() {
  if [[ -d "${output:-}" && -f "$state/demo-oa.log" ]]; then
    install -m 0644 "$state/demo-oa.log" "$output/demo-oa.log" 2>/dev/null || true
  fi
  if [[ -n "${browser_pid:-}" ]]; then
    kill "$browser_pid" 2>/dev/null || true
    wait "$browser_pid" 2>/dev/null || true
  fi
  if [[ -n "${server_pid:-}" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  sleep 2
  rm -rf -- "$profile" "$state" 2>/dev/null || {
    sleep 2
    rm -rf -- "$profile" "$state" 2>/dev/null || true
  }
}
trap cleanup EXIT

IDENTITY_GATE_STATE="$state" python3 "$root/demo_oa.py" >"$state/demo-oa.log" 2>&1 &
server_pid=$!
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:49250/oa/session/start" >/dev/null; then break; fi
  sleep 0.25
done

if [[ "$mode" == "--capture" ]]; then
  rm -rf -- "$output"
  mkdir -p "$output"
  "$browser" --user-data-dir="$profile" --no-first-run --disable-gpu \
    --remote-debugging-port="$cdp_port" --load-extension="$root/extension" about:blank >"$output/qaxbrowser.log" 2>&1 &
  browser_pid=$!
  node "$root/capture.mjs" "http://127.0.0.1:$cdp_port" "$output" | tee "$output/console-result.json"
  exit
fi

if [[ "$mode" != "interactive" ]]; then
  printf 'Usage: %s [--capture]\n' "$0" >&2
  exit 2
fi

printf 'Document Identity Gate Demo OA: http://127.0.0.1:49250/oa/session/start\n'
printf 'Choose a scenario, then click the Document Link. Close Qaxbrowser to stop.\n'
"$browser" --user-data-dir="$profile" --no-first-run --disable-gpu \
  --load-extension="$root/extension" "http://127.0.0.1:49250/oa/session/start" >"$state/qaxbrowser.log" 2>&1 &
browser_pid=$!
wait "$browser_pid"
