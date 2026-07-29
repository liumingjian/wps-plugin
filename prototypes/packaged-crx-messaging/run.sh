#!/bin/bash
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
prototype="$repo/prototypes/packaged-crx-messaging"

if [[ ! -f "$prototype/dist/wps-edit-packaged-prototype-0.1.0.crx" ]]; then
  bash "$prototype/package-crx.sh"
fi
if [[ ! -x "${XDG_DATA_HOME:-"$HOME/.local/share"}/wps-edit-packaged-crx-prototype/native-host" ]]; then
  bash "$prototype/setup-host.sh"
fi

printf '\nInstall 0.1.0 first, then 0.1.1 as the upgrade:\n'
printf '  %s\n' "$prototype/dist/wps-edit-packaged-prototype-0.1.0.crx"
printf '  %s\n' "$prototype/dist/wps-edit-packaged-prototype-0.1.1.crx"
printf 'Expected stable ID: mjjoapeohdfkepmocpahbimmmenlfdcb\n'
printf 'Demo URL: http://127.0.0.1:4317/\n\n'
exec go run "$repo/cmd/demo"
