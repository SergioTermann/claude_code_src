#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${OUT_DIR:-$ROOT/offline-dist}"
STAMP="$(date +%Y%m%d_%H%M%S)"
BUNDLE="$OUT_DIR/windrise-source-for-online-linux-$STAMP.tar.gz"

mkdir -p "$OUT_DIR"

tar \
  --exclude='.git' \
  --exclude='.DS_Store' \
  --exclude='node_modules' \
  --exclude='offline-dist' \
  --exclude='hn/.venv' \
  --exclude='hn/logs' \
  --exclude='hn/__pycache__' \
  --exclude='hn/dify_webserver_project_py313_minimal/__pycache__' \
  --exclude='hn/dify_webserver_project_py313_minimal/offline_install' \
  --exclude='hn/chat_users.db' \
  --exclude='hn/dify_webserver_project_py313_minimal/chat_users.db' \
  --exclude='hn/bootstrap_admin_credentials.txt' \
  --exclude='hn/flask_secret_key' \
  --exclude='hn/dify_webserver_project_py313_minimal/flask_secret_key' \
  --exclude='hn/dify_webserver_project_py313_minimal.tar.gz' \
  --exclude='*.pyc' \
  -czf "$BUNDLE" \
  -C "$ROOT" .

echo "$BUNDLE"
