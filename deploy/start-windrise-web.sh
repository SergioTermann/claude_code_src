#!/usr/bin/env bash
# Windrise Web 启动脚本（Ubuntu / 离线包部署）
# 用法：
#   cd /workspace/windrise          # 或你的解压目录
#   bash start-windrise-web.sh      # 前台运行
#   bash start-windrise-web.sh -d   # 后台运行，日志写到 hn/logs/

set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -d "$BASE_DIR/app/hn" ]]; then
  PROJECT_DIR="$BASE_DIR/app"
  RUNTIME_ROOT="$BASE_DIR"
elif [[ -d "$BASE_DIR/hn" ]]; then
  PROJECT_DIR="$BASE_DIR"
  RUNTIME_ROOT="$BASE_DIR"
elif [[ -d "$BASE_DIR/windrise/hn" ]]; then
  PROJECT_DIR="$BASE_DIR/windrise"
  RUNTIME_ROOT="$BASE_DIR"
else
  echo "ERROR: 未找到 hn/ 目录，请在 windrise 部署根目录执行" >&2
  exit 1
fi

CONDA_DIR="${CONDA_DIR:-$RUNTIME_ROOT/runtime/conda}"
if [[ ! -x "$CONDA_DIR/bin/python" ]]; then
  if [[ -x "$PROJECT_DIR/../runtime/conda/bin/python" ]]; then
    CONDA_DIR="$PROJECT_DIR/../runtime/conda"
  elif [[ -x "$BASE_DIR/runtime/conda/bin/python" ]]; then
    CONDA_DIR="$BASE_DIR/runtime/conda"
  else
    echo "ERROR: 未找到 conda python，请设置 CONDA_DIR" >&2
    exit 1
  fi
fi

if [[ -f "$PROJECT_DIR/hn/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$PROJECT_DIR/hn/.env"
  set +a
fi

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
export INIT_ADMIN_USERNAME="${INIT_ADMIN_USERNAME:-admin}"
export INIT_ADMIN_PASSWORD="${INIT_ADMIN_PASSWORD:-admin}"
export DIFY_REQUIRED="${DIFY_REQUIRED:-0}"
export WINDRISE_MODEL_MODE="${WINDRISE_MODEL_MODE:-vllm}"
export LLM_PROVIDER_NAME="${LLM_PROVIDER_NAME:-vLLM}"
export VLLM_API_URL="${VLLM_API_URL:-http://10.46.161.210:9527/v1/chat/completions}"
export VLLM_MODEL_NAME="${VLLM_MODEL_NAME:-Qwen-30B}"
export LMSTUDIO_BASE_URL="${LMSTUDIO_BASE_URL:-http://10.46.161.210:9527}"
export LMSTUDIO_MODEL="${LMSTUDIO_MODEL:-$VLLM_MODEL_NAME}"
export LMSTUDIO_CHAT_MODEL="${LMSTUDIO_CHAT_MODEL:-$VLLM_MODEL_NAME}"
export WINDRISE_ENABLE_THINKING="${WINDRISE_ENABLE_THINKING:-0}"
export MAX_THINKING_TOKENS="${MAX_THINKING_TOKENS:-0}"
export LLMWIKI_PROJECT="${LLMWIKI_PROJECT:-$PROJECT_DIR/风机故障码}"

mkdir -p "$PROJECT_DIR/hn/logs" "$PROJECT_DIR/data"

export CHAT_DB_FILE="${CHAT_DB_FILE:-$PROJECT_DIR/data/chat_users.db}"
ENSURE_USERS=""
for candidate in \
  "$BASE_DIR/deploy/ensure-chat-users-db.sh" \
  "$RUNTIME_ROOT/deploy/ensure-chat-users-db.sh"
do
  if [[ -f "$candidate" ]]; then
    ENSURE_USERS="$candidate"
    break
  fi
done
if [[ -n "$ENSURE_USERS" ]]; then
  bash "$ENSURE_USERS" "$PROJECT_DIR/hn" "$RUNTIME_ROOT"
fi

write_windrise_build_id() {
  local hn_dir="$1"
  local build_id="${WINDRISE_APP_VERSION:-$(date -u +%Y%m%d%H%M%S)}"
  printf '%s\n' "$build_id" > "$hn_dir/.windrise_build_id"
  export WINDRISE_APP_VERSION="$build_id"
  echo "WINDRISE build id: $build_id -> $hn_dir/.windrise_build_id"
}

BUILD_ID_SCRIPT=""
for candidate in \
  "$BASE_DIR/deploy/write-windrise-build-id.sh" \
  "$RUNTIME_ROOT/deploy/write-windrise-build-id.sh"
do
  if [[ -f "$candidate" ]]; then
    BUILD_ID_SCRIPT="$candidate"
    break
  fi
done

if [[ -n "$BUILD_ID_SCRIPT" ]]; then
  bash "$BUILD_ID_SCRIPT" "$PROJECT_DIR/hn"
else
  write_windrise_build_id "$PROJECT_DIR/hn"
fi

if [[ "${WINDRISE_KILL_EXISTING_ON_START:-0}" == "1" ]] && lsof -t -i :"${APP_PORT}" >/dev/null 2>&1; then
  echo "端口 ${APP_PORT} 已被占用，WINDRISE_KILL_EXISTING_ON_START=1，结束旧进程..."
  lsof -t -i :"${APP_PORT}" | xargs kill -9 2>/dev/null || true
  sleep 1
elif lsof -t -i :"${APP_PORT}" >/dev/null 2>&1; then
  echo "ERROR: 端口 ${APP_PORT} 已被占用。请先停止旧服务，或设置 WINDRISE_KILL_EXISTING_ON_START=1" >&2
  exit 1
fi

cd "$PROJECT_DIR/hn"
PYTHON_BIN="$CONDA_DIR/bin/python"

echo "============================================================"
echo "启动 Windrise Web"
echo "  项目目录: $PROJECT_DIR"
echo "  Python:   $PYTHON_BIN"
echo "  监听:     ${APP_HOST}:${APP_PORT}"
echo "  vLLM:     $VLLM_API_URL"
echo "============================================================"

if [[ "${1:-}" == "-d" ]]; then
  nohup "$PYTHON_BIN" dify_web_server_.py \
    >> "$PROJECT_DIR/hn/logs/windrise-web.out.log" \
    2>> "$PROJECT_DIR/hn/logs/windrise-web.err.log" &
  echo "已在后台启动，PID=$!"
  sleep 2
  curl -sS -m 3 "http://10.46.161.210:${APP_PORT}/health" && echo "" || echo "WARN: /health 暂未响应，请查看 hn/logs/"
else
  exec "$PYTHON_BIN" dify_web_server_.py
fi
