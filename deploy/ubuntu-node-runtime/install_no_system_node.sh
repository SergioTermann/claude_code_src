#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$BASE_DIR/claude_code_src"
NODE_DIR="$BASE_DIR/runtime/node"

if [[ ! -x "$NODE_DIR/bin/node" ]]; then
  echo "ERROR: packaged node not found: $NODE_DIR/bin/node" >&2
  exit 1
fi

if [[ ! -d "$PROJECT_DIR/node_modules" ]]; then
  echo "ERROR: packaged node_modules not found: $PROJECT_DIR/node_modules" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: missing command: python3" >&2
  exit 1
fi

cd "$PROJECT_DIR"

python3 - <<'PY'
import sys
if sys.version_info < (3, 10):
    raise SystemExit(f"ERROR: Python 3.10+ is required, current: {sys.version}")
PY

if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi

echo "[1/4] Installing Python dependencies"
.venv/bin/python -m pip install --upgrade pip wheel
.venv/bin/python -m pip install -r hn/requirements_no_langchain.txt

echo "[2/4] Preparing executable paths"
cp deploy/ubuntu-offline/windrise-bash bin/windrise-bash
chmod +x bin/windrise bin/windrise-bash "$BASE_DIR/run_web_no_system_node.sh"
mkdir -p hn/logs

echo "[3/4] Node runtime check"
"$NODE_DIR/bin/node" --version

echo "[4/4] App check"
.venv/bin/python -c 'import flask, flask_cors, flask_login, requests; print("python deps ok")'

cat <<EOF

Install complete. This package uses bundled Node:
  $NODE_DIR/bin/node

Start Web service:
  cd "$BASE_DIR"
  ./run_web_no_system_node.sh

EOF
