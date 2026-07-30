#!/bin/bash
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
version=${VERSION:-1.0.0}
output=${OUTPUT:-"$repo/dist/release/local-wps-editing-$version.crx"}
release_key=${CRX_RELEASE_KEY:-"$HOME/.local/share/wps-plugin-release/crx-release.pem"}
qaxbrowser=${QAXBROWSER:-/opt/qianxin.com/qaxbrowser/qaxbrowser}
expected_fingerprint=c99e0f4e735a4fce2f0718ccc4db53212f46b8813604975be5cf3781d2d7c016

if [[ ! -f "$release_key" || ! -x "$qaxbrowser" ]]; then
  printf 'The supplier release key and designated Qaxbrowser are required.\n' >&2
  exit 2
fi
if [[ -e "$output" ]]; then
  printf 'Refusing to overwrite CRX: %s\n' "$output" >&2
  exit 2
fi

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
chmod 0700 "$scratch"
printf 'Unlock the supplier CRX release key. OpenSSL reads the passphrase directly.\n'
openssl pkey -in "$release_key" -out "$scratch/release.pem"
chmod 0600 "$scratch/release.pem"
fingerprint=$(openssl pkey -in "$scratch/release.pem" -pubout -outform DER | sha256sum | cut -d' ' -f1)
if [[ "$fingerprint" != "$expected_fingerprint" ]]; then
  printf 'Release key fingerprint does not match the fixed production identity.\n' >&2
  exit 2
fi

OUTPUT="$scratch/extension" VERSION="$version" bash "$repo/scripts/stage-extension.sh"
mkdir -p "$(dirname "$output")" "$scratch/profile"
"$qaxbrowser" --user-data-dir="$scratch/profile" --no-first-run --disable-gpu \
  --pack-extension="$scratch/extension" --pack-extension-key="$scratch/release.pem"
install -m 0644 "$scratch/extension.crx" "$output"
sha256sum "$output"
printf 'Fixed extension ID: mjjoapeohdfkepmocpahbimmmenlfdcb\n'
