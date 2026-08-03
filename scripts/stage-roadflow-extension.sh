#!/bin/bash
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
output=${OUTPUT:-"$repo/dist/release/roadflow-extension"}
version=${VERSION:-1.0.0}
source_date_epoch=${SOURCE_DATE_EPOCH:-315532800}

if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$ ]]; then
  printf 'Invalid extension version: %s\n' "$version" >&2
  exit 2
fi
if [[ ! "$source_date_epoch" =~ ^[0-9]+$ || "$source_date_epoch" -lt 315532800 ]]; then
  printf 'SOURCE_DATE_EPOCH must be an integer at or after 1980-01-01.\n' >&2
  exit 2
fi
if [[ -e "$output" ]]; then
  printf 'Refusing to overwrite extension staging directory: %s\n' "$output" >&2
  exit 2
fi

mkdir -p "$output"
for file in cfb.LICENSE cfb.min.js configuration.js content.js editor.css editor.html editor.js hosted-editor.css hosted-editor.html hosted-editor.js identity-gate.js options.css options.html options.js readiness.html readiness.js service-worker.js source-identity-contract.js source-identity.js zip-core.min.js zip-js.LICENSE; do
  install -m 0644 "$repo/roadflow-extension/$file" "$output/$file"
done
sed -E "s/\"version\": \"[^\"]+\"/\"version\": \"$version\"/" "$repo/roadflow-extension/manifest.json" >"$output/manifest.json"
chmod 0644 "$output/manifest.json"
base64 --decode "$repo/extension/icon.png.base64" >"$output/icon.png"
chmod 0644 "$output/icon.png"
touch --date="@$source_date_epoch" "$output"/* "$output"

printf 'Staged RoadFlow WPS Editor %s: %s\n' "$version" "$output"
printf 'Fixed extension ID: bojjhibgkhknccepabkojdjodhhgdjfd\n'
