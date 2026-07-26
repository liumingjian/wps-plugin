#!/bin/bash
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
output=${OUTPUT:-"$repo/dist/kylin-arm64/native-host"}
go_binary=${GO_BINARY:-$(command -v go || true)}
required_go_version=go1.23.2

if [[ -z "$go_binary" || ! -x "$go_binary" ]]; then
  printf 'Go %s is required but no Go executable was found.\n' "$required_go_version" >&2
  exit 1
fi
go_version=$(GOENV=off GOTOOLCHAIN=local "$go_binary" env GOVERSION)
if [[ "$go_version" != "$required_go_version" ]]; then
  printf 'Go %s is required; %s reports %s.\n' "$required_go_version" "$go_binary" "$go_version" >&2
  exit 1
fi

mkdir -p "$(dirname "$output")"
build_cache=$(mktemp -d "${TMPDIR:-/tmp}/wps-edit-demo-go-cache.XXXXXX")
trap 'rm -rf "$build_cache"' EXIT
(
  cd "$repo"
  GOENV=off GOTOOLCHAIN=local GOCACHE="$build_cache" GOOS=linux GOARCH=arm64 CGO_ENABLED=0 \
    "$go_binary" build -trimpath -o "$output" ./cmd/native-host
)
chmod 0700 "$output"

description=$(file -b "$output")
if [[ "$description" != *ELF* || "$description" != *"ARM aarch64"* ]]; then
  printf 'Built host is not an AArch64 ELF: %s\n' "$description" >&2
  exit 1
fi
printf 'Built Kylin ARM64 host: %s\n' "$output"
printf 'Artifact: %s\n' "$description"
