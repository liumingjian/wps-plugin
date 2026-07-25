#!/bin/bash
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
install_root=${INSTALL_ROOT:-"$HOME/Library/Application Support/WPSEditDemo"}
qax_support=${QAX_SUPPORT_DIR:-"$HOME/Library/Application Support/Qaxbrowser"}
extension_id=mbkblmlopgjhdlandbjhpemifinfllim
manifest_dir="$qax_support/NativeMessagingHosts"

if [[ $(uname -s) != Darwin || $(uname -m) != arm64 ]]; then
  printf 'This development setup requires macOS arm64.\n' >&2
  exit 1
fi
if [[ ! -d "$qax_support" ]]; then
  printf 'Qaxbrowser support directory not found: %s\n' "$qax_support" >&2
  printf 'Start Qaxbrowser once, then use chrome://version to verify its profile product directory.\n' >&2
  exit 1
fi

mkdir -p "$install_root/native-host" "$manifest_dir"
rm -rf "$install_root/extension"
cp -R "$repo/extension" "$install_root/extension"
cp "$repo/native-host/run-host.sh" "$install_root/native-host/run-host.sh"
chmod +x "$install_root/native-host/run-host.sh"
GOOS=darwin GOARCH=arm64 go build -o "$install_root/native-host/native-host" "$repo/cmd/native-host"

python3 - "$repo/native-host/com.liumingjian.wps_edit_agent.json" "$manifest_dir/com.liumingjian.wps_edit_agent.json" "$install_root/native-host/run-host.sh" "$extension_id" <<'PY'
import json, sys
source, destination, host_path, extension_id = sys.argv[1:]
with open(source) as stream:
    manifest = json.load(stream)
manifest["path"] = host_path
manifest["allowed_origins"] = [f"chrome-extension://{extension_id}/"]
with open(destination, "w") as stream:
    json.dump(manifest, stream, indent=2)
    stream.write("\n")
PY

printf 'Installed extension: %s\n' "$install_root/extension"
printf 'Installed arm64 host: %s\n' "$install_root/native-host/native-host"
printf 'Installed Qaxbrowser manifest: %s\n' "$manifest_dir/com.liumingjian.wps_edit_agent.json"
printf 'Expected fixed extension ID: %s\n' "$extension_id"
