#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY_DIR="$ROOT/deploy/ubuntu-offline"
BUILD_ROOT="${BUILD_ROOT:-/tmp/windrise-offline-build}"
ENV_NAME="${ENV_NAME:-windrise}"
OUT_DIR="${OUT_DIR:-$ROOT/offline-dist}"
STAMP="$(date +%Y%m%d_%H%M%S)"
STAGE="$BUILD_ROOT/stage"
PROJECT_STAGE="$STAGE/windrise"
CONDA_ENV_TAR="$STAGE/conda-env-windrise-linux-x86_64.tar.gz"
NODE_MODULES_TAR="$STAGE/node_modules-linux-x86_64.tar.gz"
BUNDLE="$OUT_DIR/windrise-ubuntu-offline-$STAMP.tar.gz"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "ERROR: build_bundle.sh must run on an online Ubuntu/Linux x86_64 machine." >&2
  echo "       Node native packages and conda environments are platform-specific." >&2
  exit 1
fi

if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "ERROR: expected x86_64, got $(uname -m)." >&2
  exit 1
fi

if ! command -v conda >/dev/null 2>&1; then
  echo "ERROR: conda is required. Install Miniconda or Anaconda on the online build machine." >&2
  exit 1
fi

if ! command -v rsync >/dev/null 2>&1; then
  echo "ERROR: rsync is required on the online build machine." >&2
  exit 1
fi

rm -rf "$STAGE"
mkdir -p "$PROJECT_STAGE" "$OUT_DIR"

echo "[1/7] Creating/updating conda environment: $ENV_NAME"
source "$(conda info --base)/etc/profile.d/conda.sh"
if conda env list | awk '{print $1}' | grep -qx "$ENV_NAME"; then
  conda env update -n "$ENV_NAME" -f "$DEPLOY_DIR/environment.yml" --prune
else
  conda env create -n "$ENV_NAME" -f "$DEPLOY_DIR/environment.yml"
fi

echo "[2/7] Installing Linux npm dependencies"
pushd "$ROOT" >/dev/null
rm -rf node_modules
npm ci
npm run build
popd >/dev/null

echo "[3/7] Packing conda environment"
conda run -n "$ENV_NAME" conda-pack -n "$ENV_NAME" -o "$CONDA_ENV_TAR" --force

echo "[4/7] Packing Linux node_modules"
tar -czf "$NODE_MODULES_TAR" -C "$ROOT" node_modules

echo "[5/7] Copying project files"
rsync -a \
  --exclude '.git' \
  --exclude '.DS_Store' \
  --exclude 'node_modules' \
  --exclude 'offline-dist' \
  --exclude 'deploy/ubuntu-offline/*.tar.gz' \
  "$ROOT/" "$PROJECT_STAGE/"

cp "$DEPLOY_DIR/install_offline.sh" "$STAGE/install_offline.sh"
cp "$DEPLOY_DIR/run-web.sh" "$STAGE/run-web.sh"
cp "$DEPLOY_DIR/windrise-bash" "$PROJECT_STAGE/bin/windrise-bash"
chmod +x "$STAGE/install_offline.sh" "$STAGE/run-web.sh" "$PROJECT_STAGE/bin/windrise" "$PROJECT_STAGE/bin/windrise-bash"

cat > "$STAGE/README_OFFLINE_UBUNTU.md" <<'README'
# Windrise Ubuntu Offline Bundle

On the offline Ubuntu x86_64 machine:

```bash
tar -xzf windrise-ubuntu-offline-*.tar.gz
cd windrise-ubuntu-offline
bash install_offline.sh
./run-web.sh
```

CLI checks:

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
README

echo "[6/7] Writing bundle"
tar -czf "$BUNDLE" -C "$STAGE" .

echo "[7/7] Done"
echo "$BUNDLE"
