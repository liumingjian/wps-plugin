#!/bin/bash
set -euo pipefail

prototype=$(cd "$(dirname "$0")" && pwd)
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/qax" "$scratch/caller" "$scratch/install"
printf 'module example.com/setup-host-caller\n\ngo 1.23.2\n' >"$scratch/caller/go.mod"

cd "$scratch/caller"
INSTALL_ROOT="$scratch/install" QAX_MANIFEST_DIR="$scratch/qax" \
  bash "$prototype/setup-host.sh"

test -x "$scratch/install/native-host"
jq -e '.allowed_origins == ["chrome-extension://mjjoapeohdfkepmocpahbimmmenlfdcb/"]' \
  "$scratch/qax/com.liumingjian.wps_edit_agent.json" >/dev/null
