#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$BASE_DIR/app"
CONDA_DIR="$BASE_DIR/runtime/conda"

"$BASE_DIR/.ensure-runtime.sh"

export PATH="$CONDA_DIR/bin:$PROJECT_DIR/node_modules/.bin:$PATH"
export WINDRISE_MODEL_MODE="${WINDRISE_MODEL_MODE:-vllm}"
export LMSTUDIO_BASE_URL="${LMSTUDIO_BASE_URL:-http://127.0.0.1:9527}"
export LMSTUDIO_MODEL="${LMSTUDIO_MODEL:-${VLLM_MODEL_NAME:-Qwen-30B}}"
export LMSTUDIO_CHAT_MODEL="${LMSTUDIO_CHAT_MODEL:-$LMSTUDIO_MODEL}"
export VLLM_API_URL="${VLLM_API_URL:-$LMSTUDIO_BASE_URL/v1/chat/completions}"
export VLLM_MODEL_NAME="${VLLM_MODEL_NAME:-$LMSTUDIO_MODEL}"
export LLMWIKI_PROJECT="${LLMWIKI_PROJECT:-$PROJECT_DIR/风机故障码}"

cd "$PROJECT_DIR"
exec "$PROJECT_DIR/bin/windrise-bash" "$@"
