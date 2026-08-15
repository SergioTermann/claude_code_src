#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="$BASE_DIR/runtime"
CONDA_DIR="$RUNTIME_DIR/conda"
PROJECT_DIR="$BASE_DIR/windrise"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "ERROR: this offline package is for Ubuntu/Linux." >&2
  exit 1
fi

if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "ERROR: this offline package is for x86_64, got $(uname -m)." >&2
  exit 1
fi

mkdir -p "$CONDA_DIR"

echo "[1/4] Extracting conda runtime"
tar -xzf "$BASE_DIR/conda-env-windrise-linux-x86_64.tar.gz" -C "$CONDA_DIR"
"$CONDA_DIR/bin/python" "$CONDA_DIR/bin/conda-unpack"

echo "[2/4] Installing Linux node_modules"
rm -rf "$PROJECT_DIR/node_modules"
tar -xzf "$BASE_DIR/node_modules-linux-x86_64.tar.gz" -C "$PROJECT_DIR"

echo "[3/4] Preparing executables"
chmod +x "$PROJECT_DIR/bin/windrise" "$PROJECT_DIR/bin/windrise-bash" "$BASE_DIR/run-web.sh"

echo "[4/4] Smoke checks"
"$CONDA_DIR/bin/node" --version
"$CONDA_DIR/bin/python" --version

cat <<EOF

Install complete.

Start Web UI:
  cd "$BASE_DIR"
  ./run-web.sh

Use CLI:
  source "$CONDA_DIR/bin/activate"
  cd "$PROJECT_DIR"
  bin/windrise-bash doctor

EOF
