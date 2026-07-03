#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ -f "$SCRIPT_DIR/.env" ]]; then
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    if [[ -z "${!key+x}" ]]; then
      export "$key=$value"
    fi
  done < "$SCRIPT_DIR/.env"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 node。请先安装 Node.js 22 LTS 或更高版本。" >&2
  exit 127
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "未找到 npm。请安装包含 npm 的 Node.js 22 LTS。" >&2
  exit 127
fi

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  echo "当前 Node.js 版本过低：$(node -v)。请使用 Node.js 22 LTS 或更高版本。" >&2
  exit 1
fi

if [[ ! -d "$SCRIPT_DIR/node_modules" ]] || ! node -e "import('esbuild').then(()=>process.exit(0),()=>process.exit(1))" >/dev/null 2>&1; then
  echo "正在安装或刷新 Ubuntu Node.js 依赖..."
  npm ci
fi

export DOC_KNOWLEDGE_HOST="${DOC_KNOWLEDGE_HOST:-0.0.0.0}"
export DOC_KNOWLEDGE_PORT="${DOC_KNOWLEDGE_PORT:-5001}"
if [[ -z "${WINDRISE_BIN:-}" ]]; then
  if [[ -x "$SCRIPT_DIR/bin/windrise-bash" ]]; then
    export WINDRISE_BIN="$SCRIPT_DIR/bin/windrise-bash"
  else
    export WINDRISE_BIN="$SCRIPT_DIR/bin/windrise"
  fi
fi
export ANTHROPIC_MODEL_PROVIDER="${ANTHROPIC_MODEL_PROVIDER:-siliconflow}"
export SILICONFLOW_BASE_URL="${SILICONFLOW_BASE_URL:-https://api.siliconflow.cn/v1}"
export SILICONFLOW_MODEL="${SILICONFLOW_MODEL:-Qwen/Qwen3.6-35B-A3B}"
export LMSTUDIO_BASE_URL="${LMSTUDIO_BASE_URL:-$SILICONFLOW_BASE_URL}"
export LMSTUDIO_MODEL="${LMSTUDIO_MODEL:-$SILICONFLOW_MODEL}"
export LMSTUDIO_CHAT_MODEL="${LMSTUDIO_CHAT_MODEL:-$SILICONFLOW_MODEL}"
export LMSTUDIO_FORCE_CHAT="${LMSTUDIO_FORCE_CHAT:-1}"
export MAX_THINKING_TOKENS="${MAX_THINKING_TOKENS:-0}"
export WINDRISE_ENABLE_THINKING="${WINDRISE_ENABLE_THINKING:-0}"
export DISABLE_INSTALLATION_CHECKS="${DISABLE_INSTALLATION_CHECKS:-1}"
export WINDRISE="${WINDRISE:-1}"

if [[ -z "${SILICONFLOW_API_KEY:-}" && -z "${OPENAI_COMPAT_API_KEY:-}" ]]; then
  echo "未设置 SILICONFLOW_API_KEY；本地 LLMWiki 故障码查询可用，但通用大模型问答会失败。" >&2
fi

echo "Windrise Simple Web: http://${DOC_KNOWLEDGE_HOST}:${DOC_KNOWLEDGE_PORT}"
echo "SiliconFlow model: ${SILICONFLOW_MODEL}"
exec node scripts/doc-knowledge-server.mjs
