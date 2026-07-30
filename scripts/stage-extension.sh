#!/bin/bash
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
output=${OUTPUT:-"$repo/dist/release/extension"}
version=${VERSION:-1.0.0}

if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$ ]]; then
  printf 'Invalid extension version: %s\n' "$version" >&2
  exit 2
fi
if [[ -e "$output" ]]; then
  printf 'Refusing to overwrite extension staging directory: %s\n' "$output" >&2
  exit 2
fi

mkdir -p "$output"
for file in content.js sdk.js service-worker.js popup.html popup.css popup.js; do
  install -m 0644 "$repo/extension/$file" "$output/$file"
done
sed "s/\"version\": \"1.0.0\"/\"version\": \"$version\"/" "$repo/extension/manifest.json" >"$output/manifest.json"
chmod 0644 "$output/manifest.json"
base64 --decode "$repo/extension/icon.png.base64" >"$output/icon.png"
chmod 0644 "$output/icon.png"

printf 'Staged Local WPS Editing %s: %s\n' "$version" "$output"
printf 'Expected fixed extension ID: mjjoapeohdfkepmocpahbimmmenlfdcb\n'
