#!/bin/bash
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
prototype="$repo/prototypes/packaged-crx-messaging"

missing_versions=()
for version in 0.1.0 0.1.1 0.1.2; do
  if [[ ! -f "$prototype/dist/wps-edit-packaged-prototype-$version.crx" ]]; then
    missing_versions+=("$version")
  fi
done
if [[ ${#missing_versions[@]} -gt 0 ]]; then
  bash "$prototype/package-crx.sh" "${missing_versions[@]}"
fi
if [[ ! -x "${XDG_DATA_HOME:-"$HOME/.local/share"}/wps-edit-packaged-crx-prototype/native-host" ]]; then
  bash "$prototype/setup-host.sh"
fi

printf '\nInstall 0.1.0 first, then 0.1.1 and 0.1.2 as upgrades:\n'
printf '  %s\n' "$prototype/dist/wps-edit-packaged-prototype-0.1.0.crx"
printf '  %s\n' "$prototype/dist/wps-edit-packaged-prototype-0.1.1.crx"
printf '  %s\n' "$prototype/dist/wps-edit-packaged-prototype-0.1.2.crx"
printf 'Expected stable ID: mjjoapeohdfkepmocpahbimmmenlfdcb\n'
printf 'Demo URL: http://127.0.0.1:4317/\n\n'
exec go run "$repo/cmd/demo"
