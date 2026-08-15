#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${OUT_DIR:-$ROOT/offline-dist}"
STAMP="$(date +%Y%m%d_%H%M%S)"
BUILD_ROOT="${BUILD_ROOT:-/tmp/claude-code-src-bundled-node-$STAMP}"
STAGE="$BUILD_ROOT/claude-code-src-full-ubuntu-bundled-node-$STAMP"
PROJECT_STAGE="$STAGE/claude_code_src"
NODE_VERSION="${NODE_VERSION:-22.17.1}"
NODE_DIST="node-v$NODE_VERSION-linux-x64"
NODE_ARCHIVE="$OUT_DIR/$NODE_DIST.tar.xz"
BUNDLE="$OUT_DIR/claude-code-src-full-ubuntu-bundled-node-$STAMP.tar.gz"

mkdir -p "$OUT_DIR"
rm -rf "$BUILD_ROOT"
mkdir -p "$PROJECT_STAGE" "$STAGE/runtime"

if [[ ! -f "$NODE_ARCHIVE" ]]; then
  curl -L "https://nodejs.org/dist/v$NODE_VERSION/$NODE_DIST.tar.xz" -o "$NODE_ARCHIVE"
fi

tar -xJf "$NODE_ARCHIVE" -C "$STAGE/runtime"
mv "$STAGE/runtime/$NODE_DIST" "$STAGE/runtime/node"

rsync -a \
  --exclude '.git' \
  --exclude '.DS_Store' \
  --exclude '.claude-code-packed' \
  --exclude 'node_modules' \
  --exclude 'offline-dist' \
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
  --exclude '*.pyc' \
  "$ROOT/" "$PROJECT_STAGE/"

echo "[1/3] Installing Linux x64 node_modules with bundled Node/npm"
(
  cd "$PROJECT_STAGE"
  npm ci --include=optional --os=linux --cpu=x64 --libc=glibc
)

echo "[2/3] Preparing scripts"
cp "$ROOT/deploy/ubuntu-node-runtime/install_no_system_node.sh" "$STAGE/install_no_system_node.sh"
cp "$ROOT/deploy/ubuntu-node-runtime/run_web_no_system_node.sh" "$STAGE/run_web_no_system_node.sh"
cp "$ROOT/deploy/ubuntu-node-runtime/README_NO_SYSTEM_NODE.md" "$STAGE/README_NO_SYSTEM_NODE.md"
cp "$ROOT/deploy/ubuntu-offline/windrise-bash" "$PROJECT_STAGE/bin/windrise-bash"
chmod +x "$STAGE/install_no_system_node.sh" "$STAGE/run_web_no_system_node.sh"
chmod +x "$PROJECT_STAGE/bin/windrise" "$PROJECT_STAGE/bin/windrise-bash"

echo "[3/3] Writing bundle"
tar -czf "$BUNDLE" -C "$BUILD_ROOT" "$(basename "$STAGE")"

echo "$BUNDLE"
