#!/bin/bash
set -uo pipefail

install_root=$(cd "$(dirname "$0")" && pwd)
log="$install_root/native-channel.jsonl"
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '{"event":"host-started","pid":%d,"at":"%s"}\n' "$$" "$started" >>"$log"
"$install_root/native-host" "$@"
status=$?
ended=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '{"event":"host-exited","pid":%d,"at":"%s","status":%d}\n' "$$" "$ended" "$status" >>"$log"
exit "$status"
