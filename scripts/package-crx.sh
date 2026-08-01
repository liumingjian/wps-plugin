#!/bin/bash
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
version=${VERSION:-1.0.0}
export PACKAGE_NAME="Local WPS Editing"
export VERSION="$version"
export OUTPUT=${OUTPUT:-"$repo/dist/release/local-wps-editing-$version.crx"}
export RELEASE_KEY=${CRX_RELEASE_KEY:-"$HOME/.local/share/wps-plugin-release/crx-release.pem"}
export QAXBROWSER=${QAXBROWSER:-/opt/qianxin.com/qaxbrowser/qaxbrowser}
export EXPECTED_KEY_FINGERPRINT=c99e0f4e735a4fce2f0718ccc4db53212f46b8813604975be5cf3781d2d7c016
export FIXED_EXTENSION_ID=mjjoapeohdfkepmocpahbimmmenlfdcb
export STAGE_EXTENSION_SCRIPT="$repo/scripts/stage-extension.sh"

exec bash "$repo/scripts/package-fixed-id-crx.sh"
