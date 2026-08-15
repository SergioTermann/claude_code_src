#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY_DIR="$ROOT/deploy/ubuntu-offline"
BUILD_ROOT="${BUILD_ROOT:-/tmp/windrise-mac-cross-offline-build}"
OUT_DIR="${OUT_DIR:-$ROOT/offline-dist}"
STAMP="$(date +%Y%m%d_%H%M%S)"
LINUX_PREFIX="$BUILD_ROOT/linux-conda"
WORK_PROJECT="$BUILD_ROOT/project"
STAGE="$BUILD_ROOT/stage"
PROJECT_STAGE="$STAGE/windrise"
BUNDLE="$OUT_DIR/windrise-ubuntu-offline-$STAMP.tar.gz"

RSYNC_EXCLUDES=(
  --exclude '.git'
  --exclude '.DS_Store'
  --exclude '.claude'
  --exclude '.claude-code-packed'
  --exclude '.manual-pdf-tmp'
  --exclude 'node_modules'
  --exclude 'offline-dist'
  --exclude 'runtime-dist'
  --exclude 'hn/.venv*'
  --exclude 'hn/logs'
  --exclude '.env'
  --include 'deploy/seed/chat_users.db'
  --exclude 'chat_users.db*'
  --exclude 'users.db*'
  --exclude 'hn/__pycache__'
  --exclude 'scripts/__pycache__'
  --exclude 'hn/dify_webserver_project_py313_minimal/__pycache__'
  --exclude 'hn/dify_webserver_project_py313_minimal/offline_install'
  --exclude 'hn/chat_users.db*'
  --exclude 'hn/users.db*'
  --exclude 'hn/dify_webserver_project_py313_minimal/chat_users.db*'
  --exclude 'hn/bootstrap_admin_credentials.txt'
  --exclude 'hn/flask_secret_key'
  --exclude 'hn/dify_webserver_project_py313_minimal/bootstrap_admin_credentials.txt'
  --exclude 'hn/dify_webserver_project_py313_minimal/flask_secret_key'
  --exclude 'hn/dify_webserver_project_py313_minimal.tar.gz'
  --exclude '*.log'
  --exclude '*.pyc'
)

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: build_on_mac_cross.sh is intended for macOS. On Linux use build_bundle.sh." >&2
  exit 1
fi

if ! command -v conda >/dev/null 2>&1; then
  echo "ERROR: conda is required on this Mac." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm is required on this Mac." >&2
  exit 1
fi

if ! python -c 'import conda_pack' >/dev/null 2>&1; then
  echo "ERROR: conda-pack is required in the current/base Python." >&2
  echo "Install it with: conda install -n base -c conda-forge conda-pack" >&2
  exit 1
fi

rm -rf "$BUILD_ROOT"
mkdir -p "$WORK_PROJECT" "$PROJECT_STAGE" "$OUT_DIR"

echo "[1/8] Creating Linux x86_64 conda prefix"
CONDA_OVERRIDE_GLIBC="${CONDA_OVERRIDE_GLIBC:-2.35}" \
conda create -y -p "$LINUX_PREFIX" --platform linux-64 \
  python=3.13 pip 'nodejs>=22.17,<23' \
  -c conda-forge -c defaults

echo "[2/8] Downloading Python wheels for offline install"
mkdir -p "$STAGE/pip-wheels"
python -m pip download \
  --only-binary=:all: \
  --platform manylinux2014_x86_64 \
  --implementation cp \
  --python-version 313 \
  --abi cp313 \
  --dest "$STAGE/pip-wheels" \
  -r "$ROOT/hn/requirements_no_langchain.txt"

echo "[3/8] Installing Python packages into Linux prefix"
SITE_PACKAGES="$LINUX_PREFIX/lib/python3.13/site-packages"
mkdir -p "$SITE_PACKAGES"
python - "$STAGE/pip-wheels" "$SITE_PACKAGES" <<'PY'
import sys
import zipfile
from pathlib import Path

wheels_dir = Path(sys.argv[1])
site_packages = Path(sys.argv[2])
for wheel in sorted(wheels_dir.glob("*.whl")):
    print(f"  unpack {wheel.name}")
    with zipfile.ZipFile(wheel) as archive:
        archive.extractall(site_packages)
PY

echo "[4/8] Copying project to temporary build tree"
rsync -a \
  "${RSYNC_EXCLUDES[@]}" \
  "$ROOT/" "$WORK_PROJECT/"

echo "[5/8] Installing Linux x64 npm dependencies"
pushd "$WORK_PROJECT" >/dev/null
npm ci --include=optional --os=linux --cpu=x64 --libc=glibc
popd >/dev/null

echo "[6/8] Packing Linux conda prefix and node_modules"
conda-pack -p "$LINUX_PREFIX" -o "$STAGE/conda-env-windrise-linux-x86_64.tar.gz" --force --ignore-missing-files
tar -czf "$STAGE/node_modules-linux-x86_64.tar.gz" -C "$WORK_PROJECT" node_modules

echo "[7/8] Staging project files"
rsync -a \
  "${RSYNC_EXCLUDES[@]}" \
  "$WORK_PROJECT/" "$PROJECT_STAGE/"

sensitive_file="$(find "$PROJECT_STAGE" -type f \( \
  -name '.env' -o \
  -name 'chat_users.db*' -o \
  -name 'users.db*' -o \
  -name 'flask_secret_key' -o \
  -name 'bootstrap_admin_credentials.txt' \
\) ! -path '*/deploy/seed/*' -print -quit)"
if [[ -n "$sensitive_file" ]]; then
  echo "ERROR: refusing to package sensitive runtime file: $sensitive_file" >&2
  exit 1
fi

mkdir -p "$STAGE/deploy/seed"
cp "$ROOT/deploy/ensure-chat-users-db.sh" "$STAGE/deploy/ensure-chat-users-db.sh"
chmod +x "$STAGE/deploy/ensure-chat-users-db.sh"
if [[ -f "$ROOT/deploy/seed/chat_users.db" ]]; then
  cp "$ROOT/deploy/seed/chat_users.db" "$STAGE/deploy/seed/chat_users.db"
  seed_users="$(sqlite3 "$ROOT/deploy/seed/chat_users.db" "SELECT COUNT(*) FROM users;" 2>/dev/null || echo 0)"
  echo "Bundled chat_users seed: $seed_users users"
fi

cp "$DEPLOY_DIR/install_offline.sh" "$STAGE/install_offline.sh"
cp "$DEPLOY_DIR/run-web.sh" "$STAGE/run-web.sh"
cp "$DEPLOY_DIR/windrise-bash" "$PROJECT_STAGE/bin/windrise-bash"
chmod +x "$STAGE/install_offline.sh" "$STAGE/run-web.sh" "$PROJECT_STAGE/bin/windrise" "$PROJECT_STAGE/bin/windrise-bash"

cat > "$STAGE/README_OFFLINE_UBUNTU.md" <<'README'
# Windrise Ubuntu 离线运行包

适用目标：Ubuntu/Linux x86_64。

在离线 Ubuntu 上执行：

```bash
mkdir -p ~/windrise-offline
tar -xzf windrise-ubuntu-offline-*.tar.gz -C ~/windrise-offline
cd ~/windrise-offline
bash install_offline.sh
./run-web.sh
```

Web 访问地址：

```text
http://10.46.161.210:5002
```

默认管理员账号：

```text
admin / admin
```

CLI 检查：

```bash
source runtime/conda/bin/activate
cd windrise
bin/windrise-bash doctor
bin/windrise-bash "303804是什么故障，怎么处理"
```

默认连接 vLLM OpenAI 兼容模型服务：

```text
VLLM_API_URL=http://10.46.161.210:9527/v1/chat/completions
VLLM_MODEL_NAME=Qwen-30B
```

如果 vLLM 的 `--served-model-name` 不是 `Qwen-30B`，启动前设置环境变量：

```bash
export VLLM_MODEL_NAME=实际模型名称
./run-web.sh
```
README

echo "[8/8] Writing final offline bundle"
tar -czf "$BUNDLE" -C "$STAGE" .

echo "$BUNDLE"
