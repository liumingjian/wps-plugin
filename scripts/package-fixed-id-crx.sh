#!/bin/bash
set -euo pipefail

: "${PACKAGE_NAME:?PACKAGE_NAME is required}"
: "${VERSION:?VERSION is required}"
: "${OUTPUT:?OUTPUT is required}"
: "${RELEASE_KEY:?RELEASE_KEY is required}"
: "${QAXBROWSER:?QAXBROWSER is required}"
: "${EXPECTED_KEY_FINGERPRINT:?EXPECTED_KEY_FINGERPRINT is required}"
: "${FIXED_EXTENSION_ID:?FIXED_EXTENSION_ID is required}"
: "${STAGE_EXTENSION_SCRIPT:?STAGE_EXTENSION_SCRIPT is required}"

if [[ ! -f "$RELEASE_KEY" || ! -x "$QAXBROWSER" ]]; then
  printf 'The %s release key and designated Qaxbrowser are required.\n' "$PACKAGE_NAME" >&2
  exit 2
fi
if [[ -e "$OUTPUT" ]]; then
  printf 'Refusing to overwrite CRX: %s\n' "$OUTPUT" >&2
  exit 2
fi

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
chmod 0700 "$scratch"
printf 'Unlock the %s release key. OpenSSL reads the passphrase directly.\n' "$PACKAGE_NAME"
openssl pkey -in "$RELEASE_KEY" -out "$scratch/release.pem"
chmod 0600 "$scratch/release.pem"
fingerprint=$(openssl pkey -in "$scratch/release.pem" -pubout -outform DER | sha256sum | cut -d' ' -f1)
if [[ "$fingerprint" != "$EXPECTED_KEY_FINGERPRINT" ]]; then
  printf 'Release key fingerprint does not match the fixed %s identity.\n' "$PACKAGE_NAME" >&2
  exit 2
fi

OUTPUT="$scratch/extension" VERSION="$VERSION" bash "$STAGE_EXTENSION_SCRIPT"
mkdir -p "$(dirname "$OUTPUT")" "$scratch/profile"
"$QAXBROWSER" --user-data-dir="$scratch/profile" --no-first-run --disable-gpu \
  --pack-extension="$scratch/extension" --pack-extension-key="$scratch/release.pem"
install -m 0644 "$scratch/extension.crx" "$OUTPUT"
sha256sum "$OUTPUT"
printf 'Fixed extension ID: %s\n' "$FIXED_EXTENSION_ID"
