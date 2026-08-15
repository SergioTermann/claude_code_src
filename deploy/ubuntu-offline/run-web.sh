#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONDA_DIR="$BASE_DIR/runtime/conda"
PROJECT_DIR="$BASE_DIR/windrise"

export PATH="$CONDA_DIR/bin:$PATH"
export WINDRISE_ENABLED="${WINDRISE_ENABLED:-1}"
export WINDRISE_BIN="${WINDRISE_BIN:-$PROJECT_DIR/bin/windrise-bash}"
export WINDRISE_CWD="${WINDRISE_CWD:-$PROJECT_DIR}"
export APP_HOST="${APP_HOST:-0.0.0.0}"
export APP_PORT="${APP_PORT:-5002}"
export PYTHONUNBUFFERED="${PYTHONUNBUFFERED:-1}"
export WEB_SERVER="${WEB_SERVER:-auto}"
export WEB_THREADS="${WEB_THREADS:-32}"
export TARGET_CONCURRENCY="${TARGET_CONCURRENCY:-30}"
export HTTP_POOL_SIZE="${HTTP_POOL_SIZE:-64}"
export SERVER_REQUEST_QUEUE_SIZE="${SERVER_REQUEST_QUEUE_SIZE:-128}"
case "$APP_HOST" in
  127.0.0.1|localhost|::1)
    echo "APP_HOST=$APP_HOST 仅允许本机访问，将改为 0.0.0.0"
    export APP_HOST="0.0.0.0"
    ;;
esac
export INIT_ADMIN_USERNAME="${INIT_ADMIN_USERNAME:-admin}"
export INIT_ADMIN_PASSWORD="${INIT_ADMIN_PASSWORD:-admin}"
export DIFY_REQUIRED="${DIFY_REQUIRED:-0}"
export DIFY_API_URL="${DIFY_API_URL:-}"
export DIFY_API_KEY="${DIFY_API_KEY:-}"
export DIFY_APP_TYPE="${DIFY_APP_TYPE:-chat}"
export WINDRISE_MODEL_MODE="${WINDRISE_MODEL_MODE:-vllm}"
export LLM_PROVIDER_NAME="${LLM_PROVIDER_NAME:-vLLM}"
export VLLM_API_URL="${VLLM_API_URL:-http://10.46.161.210:9527/v1/chat/completions}"
export VLLM_MODEL_NAME="${VLLM_MODEL_NAME:-Qwen-30B}"
export MAX_THINKING_TOKENS="${MAX_THINKING_TOKENS:-0}"
export WINDRISE_ENABLE_THINKING="${WINDRISE_ENABLE_THINKING:-0}"
export LLMWIKI_PROJECT="${LLMWIKI_PROJECT:-$PROJECT_DIR/风机故障码}"

write_windrise_build_id() {
  local hn_dir="$1"
  local build_id="${WINDRISE_APP_VERSION:-$(date -u +%Y%m%d%H%M%S)}"
  printf '%s\n' "$build_id" > "$hn_dir/.windrise_build_id"
  export WINDRISE_APP_VERSION="$build_id"
  echo "WINDRISE build id: $build_id -> $hn_dir/.windrise_build_id"
}

mkdir -p "$PROJECT_DIR/data"
export CHAT_DB_FILE="${CHAT_DB_FILE:-$PROJECT_DIR/data/chat_users.db}"
ENSURE_USERS=""
for candidate in \
  "$BASE_DIR/deploy/ensure-chat-users-db.sh" \
  "$PROJECT_DIR/deploy/ensure-chat-users-db.sh"
do
  if [[ -f "$candidate" ]]; then
    ENSURE_USERS="$candidate"
    break
  fi
done
if [[ -n "$ENSURE_USERS" ]]; then
  bash "$ENSURE_USERS" "$PROJECT_DIR/hn" "$BASE_DIR"
fi

BUILD_ID_SCRIPT="$BASE_DIR/deploy/write-windrise-build-id.sh"
if [[ -f "$BUILD_ID_SCRIPT" ]]; then
  bash "$BUILD_ID_SCRIPT" "$PROJECT_DIR/hn"
else
  write_windrise_build_id "$PROJECT_DIR/hn"
fi

cd "$PROJECT_DIR/hn"
exec "$CONDA_DIR/bin/python" dify_web_server_.py
