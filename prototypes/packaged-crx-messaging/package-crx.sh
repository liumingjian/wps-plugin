#!/bin/bash
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
prototype="$repo/prototypes/packaged-crx-messaging"
output="$prototype/dist"
release_key=${CRX_RELEASE_KEY:-"$HOME/.local/share/wps-plugin-release/crx-release.pem"}
qaxbrowser=${QAXBROWSER:-/opt/qianxin.com/qaxbrowser/qaxbrowser}
expected_fingerprint=c99e0f4e735a4fce2f0718ccc4db53212f46b8813604975be5cf3781d2d7c016

if [[ ! -f "$release_key" || ! -x "$qaxbrowser" ]]; then
  printf 'Release key or Qaxbrowser is unavailable.\n' >&2
  exit 1
fi

scratch=$(mktemp -d)
decrypted_key="$scratch/release-key.pem"
browser_profile="$scratch/qax-profile"
trap 'rm -rf "$scratch"' EXIT
chmod 0700 "$scratch"

printf 'Unlock the supplier CRX release key (the passphrase is read only by OpenSSL).\n'
openssl pkey -in "$release_key" -out "$decrypted_key"
chmod 0600 "$decrypted_key"
fingerprint=$(openssl pkey -in "$decrypted_key" -pubout -outform DER | sha256sum | cut -d' ' -f1)
if [[ "$fingerprint" != "$expected_fingerprint" ]]; then
  printf 'Release key fingerprint %s does not match expected %s.\n' "$fingerprint" "$expected_fingerprint" >&2
  exit 1
fi

mkdir -p "$output" "$browser_profile"
for version in 0.1.0 0.1.1; do
  extension_dir="$scratch/extension-$version"
  artifact="$output/wps-edit-packaged-prototype-$version.crx"
  generated="$extension_dir.crx"
  if [[ -e "$output/extension-$version" || -e "$artifact" ]]; then
    printf 'Refusing to overwrite existing prototype output for version %s.\n' "$version" >&2
    exit 1
  fi
  mkdir "$extension_dir"
  cp "$prototype/extension/content.js" "$extension_dir/content.js"
  cp "$prototype/extension/service-worker.js" "$extension_dir/service-worker.js"
  cp "$prototype/extension/icon.svg" "$extension_dir/icon.svg"
  jq --arg version "$version" '.version = $version' \
    "$prototype/extension/manifest.json" >"$extension_dir/manifest.json"

  "$qaxbrowser" \
    --user-data-dir="$browser_profile" \
    --no-first-run \
    --disable-gpu \
    --pack-extension="$extension_dir" \
    --pack-extension-key="$decrypted_key"
  if [[ ! -f "$generated" ]]; then
    printf 'Qaxbrowser did not create expected CRX: %s\n' "$generated" >&2
    exit 1
  fi
done

for version in 0.1.0 0.1.1; do
  mv "$scratch/extension-$version" "$output/extension-$version"
  mv "$scratch/extension-$version.crx" "$output/wps-edit-packaged-prototype-$version.crx"
  printf 'Built %s\n' "$output/wps-edit-packaged-prototype-$version.crx"
done

printf 'Expected production extension ID: mjjoapeohdfkepmocpahbimmmenlfdcb\n'
