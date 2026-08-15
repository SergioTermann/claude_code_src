#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$BASE_DIR/claude_code_src"
NODE_DIR="$BASE_DIR/runtime/node"

if [[ -f "$PROJECT_DIR/hn/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$PROJECT_DIR/hn/.env"
  set +a
fi

export PATH="$NODE_DIR/bin:$PROJECT_DIR/node_modules/.bin:$PATH"
export APP_HOST="${APP_HOST:-0.0.0.0}"
export APP_PORT="${APP_PORT:-5002}"
export PYTHONUNBUFFERED="${PYTHONUNBUFFERED:-1}"
case "$APP_HOST" in
  127.0.0.1|localhost|::1)
    echo "APP_HOST=$APP_HOST 仅允许本机访问，将改为 0.0.0.0"
    export APP_HOST="0.0.0.0"
    ;;
esac
export INIT_ADMIN_USERNAME="${INIT_ADMIN_USERNAME:-admin}"
export INIT_ADMIN_PASSWORD="${INIT_ADMIN_PASSWORD:-admin}"

export WINDRISE_ENABLED="${WINDRISE_ENABLED:-1}"
export WINDRISE_BIN="${WINDRISE_BIN:-$PROJECT_DIR/bin/windrise-bash}"
export WINDRISE_CWD="${WINDRISE_CWD:-$PROJECT_DIR}"
export WINDRISE_ENABLE_THINKING="${WINDRISE_ENABLE_THINKING:-0}"
export MAX_THINKING_TOKENS="${MAX_THINKING_TOKENS:-0}"
export WINDRISE_MODEL_MODE="${WINDRISE_MODEL_MODE:-vllm}"

export DIFY_REQUIRED="${DIFY_REQUIRED:-0}"
export DIFY_API_URL="${DIFY_API_URL:-}"
export DIFY_API_KEY="${DIFY_API_KEY:-}"
export DIFY_APP_TYPE="${DIFY_APP_TYPE:-chat}"

export LLM_PROVIDER_NAME="${LLM_PROVIDER_NAME:-vLLM}"
export LMSTUDIO_BASE_URL="${LMSTUDIO_BASE_URL:-http://10.46.161.210:9527}"
export LMSTUDIO_MODEL="${LMSTUDIO_MODEL:-${VLLM_MODEL_NAME:-Qwen-30B}}"
export LMSTUDIO_CHAT_MODEL="${LMSTUDIO_CHAT_MODEL:-$LMSTUDIO_MODEL}"
export VLLM_MODEL_NAME="${VLLM_MODEL_NAME:-$LMSTUDIO_MODEL}"
export VLLM_API_URL="${VLLM_API_URL:-$LMSTUDIO_BASE_URL/v1/chat/completions}"
export LLMWIKI_PROJECT="${LLMWIKI_PROJECT:-$PROJECT_DIR/风机故障码}"

cd "$PROJECT_DIR/hn"
exec "$PROJECT_DIR/.venv/bin/python" dify_web_server_.py
