#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONDA_DIR="$BASE_DIR/runtime/conda"
PROJECT_DIR="$BASE_DIR/app"
HN_DIR="$PROJECT_DIR/hn"

"$BASE_DIR/.ensure-runtime.sh"

export PATH="$CONDA_DIR/bin:$PATH"
export CHAT_DB_FILE="${CHAT_DB_FILE:-$PROJECT_DIR/data/chat_users.db}"
ENSURE_USERS="$BASE_DIR/deploy/ensure-chat-users-db.sh"
if [[ -f "$ENSURE_USERS" ]]; then
  bash "$ENSURE_USERS" "$HN_DIR" "$BASE_DIR"
fi
cd "$HN_DIR"
exec "$CONDA_DIR/bin/python" dify_web_server_.py "$@"
