#!/bin/bash
set -euo pipefail

install_root=${INSTALL_ROOT:-"$HOME/.local/share/wps-edit-native-messaging-prototype"}
qax_config=${QAX_CONFIG_DIR:-"$HOME/.config/qaxbrowser"}
manifest="$qax_config/NativeMessagingHosts/com.liumingjian.wps_edit_agent.json"

rm -f "$manifest"
rm -rf "$install_root"
printf 'Removed prototype manifest: %s\n' "$manifest"
printf 'Removed prototype installation: %s\n' "$install_root"
