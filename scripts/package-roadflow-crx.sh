#!/bin/bash
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
version=${VERSION:-1.0.0}
export PACKAGE_NAME="RoadFlow WPS Editor"
export VERSION="$version"
export OUTPUT=${OUTPUT:-"$repo/dist/release/roadflow-wps-editor-$version.crx"}
export RELEASE_KEY=${ROADFLOW_CRX_RELEASE_KEY:-"$HOME/.local/share/wps-plugin-release/roadflow-crx-release.pem"}
export QAXBROWSER=${QAXBROWSER:-/opt/qianxin.com/qaxbrowser/qaxbrowser}
export EXPECTED_KEY_FINGERPRINT=1e997816a7ad224f01ae939e377639538097d1907943acf908bdbba61abf3257
export FIXED_EXTENSION_ID=bojjhibgkhknccepabkojdjodhhgdjfd
export STAGE_EXTENSION_SCRIPT="$repo/scripts/stage-roadflow-extension.sh"

exec bash "$repo/scripts/package-fixed-id-crx.sh"
