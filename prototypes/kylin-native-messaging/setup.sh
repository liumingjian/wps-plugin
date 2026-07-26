#!/bin/bash
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
install_root=${INSTALL_ROOT:-"$HOME/.local/share/wps-edit-native-messaging-prototype"}
qax_config=${QAX_CONFIG_DIR:-"$HOME/.config/qaxbrowser"}
manifest_dir="$qax_config/NativeMessagingHosts"
extension_id=mbkblmlopgjhdlandbjhpemifinfllim
go_binary=${GO_BINARY:-$(command -v go || true)}

if [[ $(uname -s) != Linux || $(uname -m) != aarch64 ]]; then
  printf 'This prototype requires Linux aarch64.\n' >&2
  exit 1
fi
if [[ -z "$go_binary" || ! -x "$go_binary" ]]; then
  printf 'Go 1.23.2 is required.\n' >&2
  exit 1
fi
go_version=$(GOENV=off GOTOOLCHAIN=local "$go_binary" env GOVERSION)
if [[ "$go_version" != go1.23.2 ]]; then
  printf 'Go 1.23.2 is required; %s reports %s.\n' "$go_binary" "$go_version" >&2
  exit 1
fi
if [[ ! -d "$qax_config" ]]; then
  printf 'Qaxbrowser configuration directory not found: %s\n' "$qax_config" >&2
  exit 1
fi

mkdir -p "$install_root/native-host" "$install_root/extension" "$install_root/logs" "$manifest_dir"
cp "$repo/extension/manifest.json" "$install_root/extension/manifest.json"
cp "$repo/extension/content.js" "$install_root/extension/content.js"
cp "$repo/prototypes/kylin-native-messaging/service-worker.js" "$install_root/extension/service-worker.js"

GOENV=off GOTOOLCHAIN=local GOOS=linux GOARCH=arm64 \
  "$go_binary" build -o "$install_root/native-host/native-host" "$repo/prototypes/kylin-native-messaging/main.go"
chmod 0700 "$install_root/native-host/native-host"
: > "$install_root/logs/native-host.jsonl"
chmod 0600 "$install_root/logs/native-host.jsonl"

manifest="$manifest_dir/com.liumingjian.wps_edit_agent.json"
manifest_temp="$manifest.tmp"
jq --arg path "$install_root/native-host/native-host" \
  --arg origin "chrome-extension://$extension_id/" \
  '.path = $path | .allowed_origins = [$origin]' \
  "$repo/native-host/com.liumingjian.wps_edit_agent.json" > "$manifest_temp"
mv "$manifest_temp" "$manifest"

printf 'Prototype extension: %s\n' "$install_root/extension"
printf 'Expected extension ID: %s\n' "$extension_id"
printf 'Qaxbrowser manifest: %s\n' "$manifest"
printf 'Probe log: %s\n' "$install_root/logs/native-host.jsonl"
