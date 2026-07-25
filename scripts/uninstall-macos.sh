#!/bin/bash
set -euo pipefail

install_root=${INSTALL_ROOT:-"$HOME/Library/Application Support/WPSEditDemo"}
qax_support=${QAX_SUPPORT_DIR:-"$HOME/Library/Application Support/Qaxbrowser"}
manifest="$qax_support/NativeMessagingHosts/com.liumingjian.wps_edit_agent.json"

rm -f "$manifest"
rm -rf "$install_root"
printf 'Removed Demo manifest: %s\n' "$manifest"
printf 'Removed Demo installation: %s\n' "$install_root"
