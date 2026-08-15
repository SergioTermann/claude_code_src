#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONDA_DIR="$BASE_DIR/runtime/conda"
MARKER="$CONDA_DIR/.windrise-runtime-ready"
LOCK_DIR="$CONDA_DIR/.windrise-runtime-lock"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "ERROR: this package requires Ubuntu/Linux." >&2
  exit 1
fi

if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "ERROR: this package requires x86_64, got $(uname -m)." >&2
  exit 1
fi

if [[ ! -x "$CONDA_DIR/bin/python" || ! -x "$CONDA_DIR/bin/node" ]]; then
  echo "ERROR: bundled runtime is incomplete under $CONDA_DIR" >&2
  exit 1
fi

if [[ -f "$MARKER" ]]; then
  recorded_prefix="$(sed -n '1p' "$MARKER")"
  if [[ "$recorded_prefix" != "$CONDA_DIR" ]]; then
    echo "ERROR: this extracted package was moved after its first run." >&2
    echo "Re-extract the original archive at the desired final path." >&2
    exit 1
  fi
  exit 0
fi

if mkdir "$LOCK_DIR" 2>/dev/null; then
  cleanup() {
    rmdir "$LOCK_DIR" 2>/dev/null || true
  }
  trap cleanup EXIT

  if [[ ! -f "$CONDA_DIR/bin/conda-unpack" ]]; then
    echo "ERROR: bundled runtime cannot be prepared; conda-unpack is missing." >&2
    exit 1
  fi

  echo "Preparing bundled runtime for this path (first run only)..."
  "$CONDA_DIR/bin/python" "$CONDA_DIR/bin/conda-unpack"
  printf '%s\n' "$CONDA_DIR" > "$MARKER"
  cleanup
  trap - EXIT
  exit 0
fi

for ((attempt = 0; attempt < 120; attempt++)); do
  [[ -f "$MARKER" ]] && exec "$0"
  [[ ! -d "$LOCK_DIR" ]] && exec "$0"
  sleep 0.5
done

echo "ERROR: timed out waiting for bundled runtime preparation." >&2
exit 1

