#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

export PATH="/opt/homebrew/bin:/usr/local/bin:$PROJECT_DIR/node_modules/.bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
export APP_HOST="${APP_HOST:-0.0.0.0}"
export APP_PORT="${APP_PORT:-5002}"
export PYTHONUNBUFFERED="${PYTHONUNBUFFERED:-1}"
export WINDRISE_ENABLED="${WINDRISE_ENABLED:-1}"
export WINDRISE_BIN="${WINDRISE_BIN:-$PROJECT_DIR/bin/windrise}"
export WINDRISE_CWD="${WINDRISE_CWD:-$PROJECT_DIR}"
export LLMWIKI_PROJECT="${LLMWIKI_PROJECT:-$PROJECT_DIR/风机故障码}"
export LLM_PROVIDER_NAME="${LLM_PROVIDER_NAME:-vLLM}"
export VLLM_API_URL="${VLLM_API_URL:-http://10.46.161.210:9527/v1/chat/completions}"
export VLLM_MODEL_NAME="${VLLM_MODEL_NAME:-Qwen-30B}"
export DIFY_REQUIRED="${DIFY_REQUIRED:-0}"

if [[ -n "${PYTHON:-}" ]]; then
  PYTHON_BIN="$PYTHON"
elif [[ -x "$SCRIPT_DIR/.venv/bin/python" ]]; then
  PYTHON_BIN="$SCRIPT_DIR/.venv/bin/python"
elif command -v python3.13 >/dev/null 2>&1; then
  PYTHON_BIN="python3.13"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
else
  echo "未找到 Python。请先安装 python3 或 python3.13。" >&2
  exit 127
fi

cd "$SCRIPT_DIR"
exec "$PYTHON_BIN" dify_web_server_.py
