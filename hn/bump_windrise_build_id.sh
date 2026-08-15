#!/usr/bin/env bash
# Bump deploy version token so browsers fetch fresh HTML/JS after release.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_ID_FILE="${SCRIPT_DIR}/.windrise_build_id"
BUILD_ID="$(date -u +'%Y%m%d-%H%M%S')-$(git -C "${SCRIPT_DIR}/.." rev-parse --short HEAD 2>/dev/null || echo local)"

printf '%s\n' "${BUILD_ID}" > "${BUILD_ID_FILE}"
echo "Windrise build id: ${BUILD_ID}"
echo "Written to ${BUILD_ID_FILE}"
