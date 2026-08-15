#!/usr/bin/env bash
# Write a deploy build id so browsers pick up new frontend/backend without Ctrl+Shift+R.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HN_DIR="${1:-$SCRIPT_DIR/../hn}"

if [[ ! -d "$HN_DIR" ]]; then
  echo "ERROR: hn directory not found: $HN_DIR" >&2
  exit 1
fi

BUILD_ID="${WINDRISE_APP_VERSION:-$(date -u +%Y%m%d%H%M%S)}"
printf '%s\n' "$BUILD_ID" > "$HN_DIR/.windrise_build_id"
export WINDRISE_APP_VERSION="$BUILD_ID"
echo "WINDRISE build id: $BUILD_ID -> $HN_DIR/.windrise_build_id"
