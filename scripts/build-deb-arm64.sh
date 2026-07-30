#!/bin/bash
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
version=${VERSION:-1.0.0-1}
output=${OUTPUT:-"$repo/dist/release/local-wps-editing_${version}_arm64.deb"}
maintainer=${MAINTAINER:-}

if [[ -z "$maintainer" || "$maintainer" != *"<"*"@"*">"* || "${maintainer,,}" == *noreply* || "${maintainer,,}" == *placeholder* ]]; then
  printf 'MAINTAINER must be a real supplier support name and email.\n' >&2
  exit 2
fi
if [[ -e "$output" ]]; then
  printf 'Refusing to overwrite DEB: %s\n' "$output" >&2
  exit 2
fi

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
package="$scratch/package"
mkdir -p "$package/DEBIAN" "$package/usr/lib/local-wps-editing" "$package/usr/bin" \
  "$package/usr/share/applications" "$package/usr/share/icons/hicolor/64x64/apps" \
  "$package/usr/share/doc/local-wps-editing"

build_cache=$(mktemp -d "$scratch/go-cache.XXXXXX")
(cd "$repo" && GOENV=off GOTOOLCHAIN=local GOCACHE="$build_cache" GOOS=linux GOARCH=arm64 CGO_ENABLED=0 \
  go build -trimpath -ldflags "-s -w -X main.buildVersion=$version" -o "$package/usr/lib/local-wps-editing/native-host" ./cmd/native-host)
install -m 0755 "$repo/packaging/local-wps-editing-setup" "$package/usr/bin/local-wps-editing-setup"
install -m 0644 "$repo/packaging/local-wps-editing-setup.desktop" "$package/usr/share/applications/local-wps-editing-setup.desktop"
base64 --decode "$repo/extension/icon.png.base64" >"$package/usr/share/icons/hicolor/64x64/apps/local-wps-editing.png"
install -m 0644 "$repo/README.md" "$package/usr/share/doc/local-wps-editing/README.md"
install -m 0644 "$repo/docs/customer-installation.md" "$package/usr/share/doc/local-wps-editing/customer-installation.md"

cat >"$package/DEBIAN/control" <<EOF
Package: local-wps-editing
Version: $version
Architecture: arm64
Maintainer: $maintainer
Section: office
Priority: optional
Depends: python3 (>= 3.8), python3-gi, gir1.2-gtk-3.0, xdg-utils
Description: Browser-initiated local DOCX editing with WPS
 Opens server-managed DOCX documents in local WPS and submits verified versions.
EOF
chmod 0644 "$package/DEBIAN/control"
mkdir -p "$(dirname "$output")"
dpkg-deb --root-owner-group --build "$package" "$output" >/dev/null
sha256sum "$output"
