#!/bin/bash
set -euo pipefail

data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}
config_home=${XDG_CONFIG_HOME:-"$HOME/.config"}
install_root=${INSTALL_ROOT:-"$data_home/wps-edit-packaged-crx-prototype"}
manifest=${QAX_MANIFEST_DIR:-"$config_home/qaxbrowser/NativeMessagingHosts"}/com.liumingjian.wps_edit_agent.json

case "$install_root" in
  ""|/|"$HOME"|"$data_home")
    printf 'Refusing unsafe prototype installation root: %s\n' "$install_root" >&2
    exit 1
    ;;
esac
if [[ -f "$install_root/previous-native-host-manifest.json" ]]; then
  cp "$install_root/previous-native-host-manifest.json" "$manifest"
  printf 'Restored previous Native Messaging manifest: %s\n' "$manifest"
else
  rm -f "$manifest"
  printf 'Removed prototype Native Messaging manifest: %s\n' "$manifest"
fi
rm -rf "$install_root"
printf 'Removed prototype host installation: %s\n' "$install_root"
