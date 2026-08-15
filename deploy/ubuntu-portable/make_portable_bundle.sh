#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${OUT_DIR:-$ROOT/offline-dist}"
STAMP="$(date +%Y%m%d_%H%M%S)"
BUILD_ROOT="${BUILD_ROOT:-/tmp/claude-code-src-portable-$STAMP}"
STAGE="$BUILD_ROOT/claude-code-src-full-ubuntu-portable-$STAMP"
PROJECT_STAGE="$STAGE/claude_code_src"
BUNDLE="$OUT_DIR/claude-code-src-full-ubuntu-portable-$STAMP.tar.gz"

NODE_VERSION="${NODE_VERSION:-22.17.1}"
NODE_DIST="node-v$NODE_VERSION-linux-x64"
NODE_ARCHIVE="$OUT_DIR/$NODE_DIST.tar.xz"

PYTHON_VERSION_TAG="${PYTHON_VERSION_TAG:-20260623}"
PYTHON_DIST="${PYTHON_DIST:-cpython-3.12.13+20260623-x86_64-unknown-linux-gnu-install_only}"
PYTHON_ARCHIVE="$OUT_DIR/$PYTHON_DIST.tar.gz"
PYTHON_URL="${PYTHON_URL:-https://github.com/astral-sh/python-build-standalone/releases/download/$PYTHON_VERSION_TAG/cpython-3.12.13%2B20260623-x86_64-unknown-linux-gnu-install_only.tar.gz}"

mkdir -p "$OUT_DIR"
rm -rf "$BUILD_ROOT"
mkdir -p "$PROJECT_STAGE" "$STAGE/runtime"

if [[ ! -f "$NODE_ARCHIVE" ]]; then
  curl -L "https://nodejs.org/dist/v$NODE_VERSION/$NODE_DIST.tar.xz" -o "$NODE_ARCHIVE"
fi
if [[ ! -f "$PYTHON_ARCHIVE" ]]; then
  curl -L "$PYTHON_URL" -o "$PYTHON_ARCHIVE"
fi

tar -xJf "$NODE_ARCHIVE" -C "$STAGE/runtime"
mv "$STAGE/runtime/$NODE_DIST" "$STAGE/runtime/node"

tar -xzf "$PYTHON_ARCHIVE" -C "$STAGE/runtime"
if [[ -d "$STAGE/runtime/python" ]]; then
  :
else
  python_dir="$(find "$STAGE/runtime" -maxdepth 1 -type d -name 'python*' | head -n 1)"
  mv "$python_dir" "$STAGE/runtime/python"
fi

site_packages="$STAGE/runtime/python/lib/python3.12/site-packages"
mkdir -p "$site_packages"

echo "[1/5] Downloading Python wheels for bundled runtime"
mkdir -p "$BUILD_ROOT/wheels"
python3 -m pip download \
  --only-binary=:all: \
  --platform manylinux2014_x86_64 \
  --implementation cp \
  --python-version 312 \
  --abi cp312 \
  --dest "$BUILD_ROOT/wheels" \
  -r "$ROOT/hn/requirements_no_langchain.txt"

echo "[2/5] Unpacking Python wheels into runtime"
python3 - "$BUILD_ROOT/wheels" "$site_packages" <<'PY'
import sys
import zipfile
from pathlib import Path

wheels = Path(sys.argv[1])
site_packages = Path(sys.argv[2])
for wheel in sorted(wheels.glob("*.whl")):
    print(f"  unpack {wheel.name}")
    with zipfile.ZipFile(wheel) as archive:
        archive.extractall(site_packages)
PY

echo "[3/5] Copying project and installing Linux node_modules"
rsync -a \
  --exclude '.git' \
  --exclude '.DS_Store' \
  --exclude '.claude-code-packed' \
  --exclude '.manual-pdf-tmp' \
  --exclude 'node_modules' \
  --exclude 'offline-dist' \
  --exclude 'runtime-dist' \
  --exclude 'hn/.venv' \
  --exclude 'hn/.venv39' \
  --exclude 'hn/.venv314' \
  --exclude 'hn/logs' \
  --exclude '.env' \
  --exclude 'hn/chat_users.db' \
  --exclude 'hn/__pycache__' \
  --exclude 'scripts/__pycache__' \
  --exclude 'hn/bootstrap_admin_credentials.txt' \
  --exclude 'hn/flask_secret_key' \
  --exclude 'hn/dify_webserver_project_py313_minimal/offline_install' \
  --exclude 'hn/dify_webserver_project_py313_minimal/__pycache__' \
  --exclude 'hn/dify_webserver_project_py313_minimal/bootstrap_admin_credentials.txt' \
  --exclude 'hn/dify_webserver_project_py313_minimal/flask_secret_key' \
  --exclude 'hn/dify_webserver_project_py313_minimal/chat_users.db' \
  --exclude 'hn/dify_webserver_project_py313_minimal/chat_users.db-*' \
  --exclude '*.log' \
  --exclude '*.pyc' \
  "$ROOT/" "$PROJECT_STAGE/"

(
  cd "$PROJECT_STAGE"
  npm ci --include=optional --os=linux --cpu=x64 --libc=glibc
)

echo "[4/5] Preparing launch scripts"
cp "$ROOT/deploy/ubuntu-portable/run_web_portable.sh" "$STAGE/run_web_portable.sh"
cp "$ROOT/deploy/ubuntu-portable/README_PORTABLE.md" "$STAGE/README_PORTABLE.md"
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
VLLM_API_URL=http://10.46.161.210:9527/v1/chat/completions
VLLM_MODEL_NAME=Qwen-30B
VLLM_API_KEY=
EOF
cat > "$STAGE/windrise" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$BASE_DIR/claude_code_src"
NODE_DIR="$BASE_DIR/runtime/node"

if [[ ! -x "$NODE_DIR/bin/node" ]]; then
  echo "ERROR: packaged Node runtime not found: $NODE_DIR/bin/node" >&2
  exit 1
fi

export PATH="$NODE_DIR/bin:$PROJECT_DIR/node_modules/.bin:$PATH"
export WINDRISE_MODEL_MODE="${WINDRISE_MODEL_MODE:-vllm}"
export VLLM_API_URL="${VLLM_API_URL:-http://10.46.161.210:9527/v1/chat/completions}"
export VLLM_MODEL_NAME="${VLLM_MODEL_NAME:-Qwen-30B}"
export VLLM_API_KEY="${VLLM_API_KEY:-}"
export LLMWIKI_PROJECT="${LLMWIKI_PROJECT:-$PROJECT_DIR/风机故障码}"

cd "$PROJECT_DIR"
exec "$PROJECT_DIR/bin/windrise-bash" "$@"
EOF
chmod +x "$STAGE/run_web_portable.sh" "$STAGE/windrise"
chmod +x "$PROJECT_STAGE/bin/windrise" "$PROJECT_STAGE/bin/windrise-bash"

echo "[5/5] Writing portable bundle"
tar -czf "$BUNDLE" -C "$BUILD_ROOT" "$(basename "$STAGE")"

echo "$BUNDLE"
