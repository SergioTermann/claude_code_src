#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${OUT_DIR:-$ROOT/offline-dist}"
STAMP="$(date +%Y%m%d_%H%M%S)"
BUILD_ROOT="${BUILD_ROOT:-/tmp/windrise-ubuntu-source-build-$STAMP}"
STAGE="$BUILD_ROOT/windrise-ubuntu-source-$STAMP"
PROJECT_STAGE="$STAGE/windrise"
BUNDLE="$OUT_DIR/windrise-ubuntu-source-$STAMP.tar.gz"

mkdir -p "$OUT_DIR"
rm -rf "$BUILD_ROOT"
mkdir -p "$PROJECT_STAGE"

rsync -a \
  --exclude '.git' \
  --exclude '.DS_Store' \
  --exclude '.claude-code-packed' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'offline-dist' \
  --exclude '*.tgz' \
  --exclude 'hn/.venv' \
  --exclude 'hn/.venv39' \
  --exclude 'hn/.venv314' \
  --exclude 'hn/logs' \
  --exclude 'hn/.env' \
  --exclude 'hn/__pycache__' \
  --exclude 'scripts/__pycache__' \
  --exclude 'hn/chat_users.db' \
  --exclude 'hn/bootstrap_admin_credentials.txt' \
  --exclude 'hn/flask_secret_key' \
  --exclude 'hn/dify_webserver_project_py313_minimal/offline_install' \
  --exclude 'hn/dify_webserver_project_py313_minimal/__pycache__' \
  --exclude 'hn/dify_webserver_project_py313_minimal/chat_users.db' \
  --exclude 'hn/dify_webserver_project_py313_minimal/bootstrap_admin_credentials.txt' \
  --exclude 'hn/dify_webserver_project_py313_minimal/flask_secret_key' \
  --exclude 'hn/dify_webserver_project_py313_minimal.tar.gz' \
  --exclude '*.pyc' \
  "$ROOT/" "$PROJECT_STAGE/"

cp "$ROOT/deploy/ubuntu-source/install_ubuntu.sh" "$STAGE/install_ubuntu.sh"
cp "$ROOT/deploy/ubuntu-source/run_web_ubuntu.sh" "$STAGE/run_web_ubuntu.sh"
cp "$ROOT/deploy/ubuntu-source/windrise-web.service.example" "$STAGE/windrise-web.service.example"
cp "$ROOT/deploy/ubuntu-source/README_UBUNTU_SOURCE.md" "$STAGE/README_UBUNTU_SOURCE.md"
cp "$ROOT/deploy/ubuntu-offline/windrise-bash" "$PROJECT_STAGE/bin/windrise-bash"

cat > "$PROJECT_STAGE/hn/.env.ubuntu-vllm.example" <<'EOF'
APP_HOST=0.0.0.0
APP_PORT=5002

INIT_ADMIN_USERNAME=admin
INIT_ADMIN_PASSWORD=admin

DIFY_REQUIRED=0
DIFY_API_URL=
DIFY_API_KEY=
DIFY_APP_TYPE=chat

WINDRISE_ENABLED=1
WINDRISE_MODEL_MODE=vllm
WINDRISE_ENABLE_THINKING=0
WINDRISE_SHOW_THINKING_STATUS=1
WINDRISE_SINGLE_SEMANTIC_PASS=1
WINDRISE_QUERY_CONSOLIDATOR_ENABLED=1
WINDRISE_QUERY_CONSOLIDATOR_TIMEOUT=45
WINDRISE_CHAT_TIMEOUT=45
WINDRISE_LLMWIKI_TIMEOUT=4
WINDRISE_LLM_RETRY_SECONDS=5
WINDRISE_LLM_FIRST_ENABLED=1
WINDRISE_STREAM_CHUNK_DELAY=0.02

LLM_PROVIDER_NAME=vLLM
LMSTUDIO_BASE_URL=http://10.46.161.210:9527
LMSTUDIO_MODEL=Qwen-30B
LMSTUDIO_CHAT_MODEL=Qwen-30B
LMSTUDIO_API_KEY=
VLLM_API_URL=http://10.46.161.210:9527/v1/chat/completions
VLLM_MODEL_NAME=Qwen-30B
VLLM_API_KEY=
EOF

chmod +x "$STAGE/install_ubuntu.sh" "$STAGE/run_web_ubuntu.sh"
chmod +x "$PROJECT_STAGE/bin/windrise" "$PROJECT_STAGE/bin/windrise-bash"

tar -czf "$BUNDLE" -C "$BUILD_ROOT" "$(basename "$STAGE")"

echo "$BUNDLE"
