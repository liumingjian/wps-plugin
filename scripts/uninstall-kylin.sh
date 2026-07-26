#!/bin/bash
set -euo pipefail

data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}
config_home=${XDG_CONFIG_HOME:-"$HOME/.config"}
state_home=${XDG_STATE_HOME:-"$HOME/.local/state"}
install_root=${INSTALL_ROOT:-"$data_home/wps-edit-demo"}
state_root=${STATE_ROOT:-"$state_home/wps-edit-demo"}
qax_config=${QAX_CONFIG_DIR:-"$config_home/qaxbrowser"}
manifest="$qax_config/NativeMessagingHosts/com.liumingjian.wps_edit_agent.json"

case "$install_root" in
  ""|/|"$HOME"|"$data_home")
    printf 'Refusing unsafe installation root: %s\n' "$install_root" >&2
    exit 1
    ;;
esac
rm -f "$manifest"
rm -rf "$install_root"
printf 'Removed Demo manifest: %s\n' "$manifest"
printf 'Removed Demo installation: %s\n' "$install_root"
printf 'Retained Work Copies and Snapshots: %s\n' "$state_root"
