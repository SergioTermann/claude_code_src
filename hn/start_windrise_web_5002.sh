#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

export APP_HOST="${APP_HOST:-0.0.0.0}"
export APP_PORT="${APP_PORT:-5002}"
export WINDRISE_ENABLED="${WINDRISE_ENABLED:-1}"
export WINDRISE_BIN="${WINDRISE_BIN:-$PROJECT_DIR/bin/windrise}"
export WINDRISE_CWD="${WINDRISE_CWD:-$PROJECT_DIR}"
export LLMWIKI_PROJECT="${LLMWIKI_PROJECT:-$PROJECT_DIR/风机故障码}"
export PYTHONUNBUFFERED="${PYTHONUNBUFFERED:-1}"
export PYTHONPATH="$SCRIPT_DIR/.venv314/lib/python3.14/site-packages${PYTHONPATH:+:$PYTHONPATH}"

cd "$SCRIPT_DIR"
exec "$SCRIPT_DIR/.venv314/bin/python" "$SCRIPT_DIR/dify_web_server_.py"
