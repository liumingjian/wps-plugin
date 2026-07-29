#!/bin/bash
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}
config_home=${XDG_CONFIG_HOME:-"$HOME/.config"}
install_root=${INSTALL_ROOT:-"$data_home/wps-edit-packaged-crx-prototype"}
manifest_dir=${QAX_MANIFEST_DIR:-"$config_home/qaxbrowser/NativeMessagingHosts"}
manifest="$manifest_dir/com.liumingjian.wps_edit_agent.json"
extension_id=mjjoapeohdfkepmocpahbimmmenlfdcb

case "$install_root" in
  ""|/|"$HOME"|"$data_home")
    printf 'Refusing unsafe prototype installation root: %s\n' "$install_root" >&2
    exit 1
    ;;
esac
if [[ $(uname -s) != Linux || $(uname -m) != aarch64 ]]; then
  printf 'This prototype requires Linux aarch64.\n' >&2
  exit 1
fi
if [[ ! -d "$manifest_dir" ]]; then
  printf 'Qaxbrowser Native Messaging directory is unavailable: %s\n' "$manifest_dir" >&2
  exit 1
fi
if [[ -e "$install_root" && ! -d "$install_root" ]]; then
  printf 'Prototype is already installed: %s\n' "$install_root" >&2
  exit 1
fi
if [[ -d "$install_root" && -n $(find "$install_root" -mindepth 1 -maxdepth 1 -print -quit) ]]; then
  printf 'Prototype is already installed: %s\n' "$install_root" >&2
  exit 1
fi

mkdir -p "$install_root"
chmod 0700 "$install_root"
(
  cd "$repo"
  GOENV=off GOTOOLCHAIN=local GOOS=linux GOARCH=arm64 \
    go build -o "$install_root/native-host" ./cmd/native-host
)
cp "$repo/prototypes/packaged-crx-messaging/native-host-wrapper.sh" "$install_root/native-host-wrapper.sh"
chmod 0700 "$install_root/native-host" "$install_root/native-host-wrapper.sh"
: >"$install_root/native-channel.jsonl"
chmod 0600 "$install_root/native-channel.jsonl"

if [[ -f "$manifest" ]]; then
  cp "$manifest" "$install_root/previous-native-host-manifest.json"
  chmod 0600 "$install_root/previous-native-host-manifest.json"
fi
manifest_temp="$manifest.prototype.$$"
trap 'rm -f "$manifest_temp"' EXIT
"$install_root/native-host" manifest \
  --path "$install_root/native-host-wrapper.sh" \
  --origin "chrome-extension://$extension_id/" >"$manifest_temp"
chmod 0600 "$manifest_temp"
mv "$manifest_temp" "$manifest"
trap - EXIT

printf 'Installed prototype host: %s\n' "$install_root/native-host"
printf 'Native channel log: %s\n' "$install_root/native-channel.jsonl"
printf 'Allowed production origin: chrome-extension://%s/\n' "$extension_id"
