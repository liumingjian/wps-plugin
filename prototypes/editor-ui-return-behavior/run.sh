#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/../.." && pwd)"
port="${PORT:-4173}"

echo "Editor UI prototype: http://127.0.0.1:${port}/prototypes/editor-ui-return-behavior/"
exec python3 -m http.server "$port" --bind 127.0.0.1 --directory "$repo_dir"

