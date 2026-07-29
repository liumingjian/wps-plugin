#!/bin/bash
set -euo pipefail

prototype=$(cd "$(dirname "$0")" && pwd)
session=${PLAYWRIGHT_CLI_SESSION:-qax-fixed}

playwright-cli -s="$session" run-code --filename="$prototype/verify-browser.js"
