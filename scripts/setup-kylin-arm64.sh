#!/bin/bash
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}
config_home=${XDG_CONFIG_HOME:-"$HOME/.config"}
state_home=${XDG_STATE_HOME:-"$HOME/.local/state"}
install_root=${INSTALL_ROOT:-"$data_home/wps-edit-demo"}
state_root=${STATE_ROOT:-"$state_home/wps-edit-demo"}
qax_config=${QAX_CONFIG_DIR:-"$config_home/qaxbrowser"}
manifest_dir="$qax_config/NativeMessagingHosts"
manifest="$manifest_dir/com.liumingjian.wps_edit_agent.json"
host_binary=${HOST_BINARY:-"$repo/dist/kylin-arm64/native-host"}
extension_id=mbkblmlopgjhdlandbjhpemifinfllim

case "$install_root" in
  ""|/|"$HOME"|"$data_home")
    printf 'Refusing unsafe installation root: %s\n' "$install_root" >&2
    exit 1
    ;;
esac
if [[ $(uname -s) != Linux || $(uname -m) != aarch64 ]]; then
  printf 'This development setup requires Linux aarch64.\n' >&2
  exit 1
fi
if [[ ! -f "$host_binary" || ! -x "$host_binary" ]]; then
  printf 'Built host not found or not executable: %s\n' "$host_binary" >&2
  printf 'Build it first with bash ./scripts/build-kylin-arm64.sh.\n' >&2
  exit 1
fi
description=$(file -b "$host_binary")
if [[ "$description" != *ELF* || "$description" != *"ARM aarch64"* ]]; then
  printf 'Host is not an AArch64 ELF: %s\n' "$description" >&2
  exit 1
fi
if [[ ! -d "$qax_config" ]]; then
  printf 'Qaxbrowser configuration directory not found: %s\n' "$qax_config" >&2
  printf 'Start Qaxbrowser once, then verify its profile path at chrome://version.\n' >&2
  exit 1
fi

rm -rf "$install_root"
mkdir -p "$install_root/native-host" "$manifest_dir" "$state_root/tasks"
chmod 0700 "$install_root" "$install_root/native-host" "$state_root" "$state_root/tasks"
cp -R "$repo/extension" "$install_root/extension"
find "$install_root/extension" -type d -exec chmod 0700 {} +
find "$install_root/extension" -type f -exec chmod 0600 {} +
cp "$host_binary" "$install_root/native-host/native-host"
chmod 0700 "$install_root/native-host/native-host"

manifest_temp="$manifest.tmp.$$"
trap 'rm -f "$manifest_temp"' EXIT
"$install_root/native-host/native-host" manifest \
  --path "$install_root/native-host/native-host" \
  --origin "chrome-extension://$extension_id/" >"$manifest_temp"
chmod 0600 "$manifest_temp"
mv "$manifest_temp" "$manifest"
trap - EXIT

printf 'Installed extension: %s\n' "$install_root/extension"
printf 'Expected fixed extension ID: %s\n' "$extension_id"
printf 'Installed ARM64 host: %s\n' "$install_root/native-host/native-host"
printf 'Installed Qaxbrowser manifest: %s\n' "$manifest"
printf 'Task state and retained Snapshots: %s\n' "$state_root"
