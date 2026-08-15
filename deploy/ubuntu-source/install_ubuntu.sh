#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$BASE_DIR/windrise}"

if [[ ! -d "$PROJECT_DIR" ]]; then
  PROJECT_DIR="$BASE_DIR"
fi

cd "$PROJECT_DIR"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: missing command: $1" >&2
    exit 1
  fi
}

need_cmd python3
need_cmd node
need_cmd npm

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 22 )); then
  echo "ERROR: Node.js 22+ is required, current: $(node --version)" >&2
  echo "Install Node.js 22 first, then rerun this script." >&2
  exit 1
fi

python3 - <<'PY'
import sys
if sys.version_info < (3, 10):
    raise SystemExit(f"ERROR: Python 3.10+ is required, current: {sys.version}")
PY

if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi

echo "[1/5] Installing Python dependencies"
.venv/bin/python -m pip install --upgrade pip wheel
.venv/bin/python -m pip install -r hn/requirements_no_langchain.txt

echo "[2/5] Installing Node dependencies"
npm ci

echo "[3/5] Building Node runtime"
npm run build

echo "[4/5] Preparing executables"
if [[ -f deploy/ubuntu-offline/windrise-bash ]]; then
  cp deploy/ubuntu-offline/windrise-bash bin/windrise-bash
fi
chmod +x bin/windrise bin/windrise-bash
mkdir -p hn/logs
if [[ ! -f hn/.env && -f hn/.env.ubuntu-vllm.example ]]; then
  cp hn/.env.ubuntu-vllm.example hn/.env
  echo "Created hn/.env from the Ubuntu vLLM template"
fi

echo "[5/5] Smoke checks"
.venv/bin/python -c 'import flask, flask_cors, flask_login, requests; print("python deps ok")'
node --version
node dist/claude.js --version >/dev/null || true

cat <<EOF

Install complete.

Start Web service:
  cd "$BASE_DIR"
  ./run_web_ubuntu.sh

Default URL:
  http://<ubuntu-ip>:5002

Default admin:
  admin / admin

EOF
