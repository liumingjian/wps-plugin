#!/bin/bash
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
install_root=${INSTALL_ROOT:-"$HOME/Library/Application Support/WPSEditDemo"}
qax_support=${QAX_SUPPORT_DIR:-"$HOME/Library/Application Support/Qaxbrowser"}
extension_id=mbkblmlopgjhdlandbjhpemifinfllim
manifest_dir="$qax_support/NativeMessagingHosts"
go_binary=${GO_BINARY:-$(command -v go || true)}
required_go_version=go1.23.2

if [[ -z "$go_binary" || ! -x "$go_binary" ]]; then
  printf 'Go %s is required but no Go executable was found.\n' "$required_go_version" >&2
  exit 1
fi
go_version=$(GOENV=off GOTOOLCHAIN=local "$go_binary" env GOVERSION)
if [[ "$go_version" != "$required_go_version" ]]; then
  printf 'Go %s is required; %s reports %s.\n' "$required_go_version" "$go_binary" "$go_version" >&2
  printf 'Install Go 1.23.2 or set GO_BINARY to its executable path.\n' >&2
  exit 1
fi

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
build_cache=$(mktemp -d "${TMPDIR:-/tmp}/wps-edit-demo-go-cache.XXXXXX")
trap 'rm -rf "$build_cache"' EXIT
(
  cd "$repo"
  GOENV=off GOTOOLCHAIN=local GOCACHE="$build_cache" GOOS=darwin GOARCH=arm64 \
    "$go_binary" build -o "$install_root/native-host/native-host" ./cmd/native-host
)

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
