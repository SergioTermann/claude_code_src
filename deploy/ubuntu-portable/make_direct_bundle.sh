#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${OUT_DIR:-$ROOT/offline-dist}"
STAMP="$(date +%Y%m%d_%H%M%S)"
BUILD_ROOT="${BUILD_ROOT:-/tmp/windrise-direct-build-$STAMP}"
PACKAGE_NAME="windrise-ubuntu-x86_64-direct-$STAMP"
SOURCE_STAGE="$BUILD_ROOT/source"
DIRECT_STAGE="$BUILD_ROOT/$PACKAGE_NAME"
BUNDLE="$OUT_DIR/$PACKAGE_NAME.tar.gz"
SOURCE_BUNDLE="${1:-}"

if [[ -z "$SOURCE_BUNDLE" ]]; then
  candidates=("$OUT_DIR"/windrise-ubuntu-offline-*.tar.gz)
  if [[ ! -e "${candidates[0]}" ]]; then
    echo "ERROR: no windrise-ubuntu-offline-*.tar.gz found in $OUT_DIR" >&2
    exit 1
  fi
  SOURCE_BUNDLE="${candidates[${#candidates[@]} - 1]}"
fi

if [[ ! -f "$SOURCE_BUNDLE" ]]; then
  echo "ERROR: source bundle not found: $SOURCE_BUNDLE" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
rm -rf "$BUILD_ROOT"
mkdir -p "$SOURCE_STAGE" "$DIRECT_STAGE/runtime/conda"

echo "[1/6] Extracting offline bundle"
tar -xzf "$SOURCE_BUNDLE" -C "$SOURCE_STAGE"

for required in \
  conda-env-windrise-linux-x86_64.tar.gz \
  node_modules-linux-x86_64.tar.gz \
  windrise; do
  if [[ ! -e "$SOURCE_STAGE/$required" ]]; then
    echo "ERROR: source bundle is missing $required" >&2
    exit 1
  fi
done

echo "[2/6] Expanding bundled Linux runtimes"
tar -xzf "$SOURCE_STAGE/conda-env-windrise-linux-x86_64.tar.gz" \
  -C "$DIRECT_STAGE/runtime/conda"

echo "[3/6] Expanding application and Linux node_modules"
rsync -a "$SOURCE_STAGE/windrise/" "$DIRECT_STAGE/app/"
tar -xzf "$SOURCE_STAGE/node_modules-linux-x86_64.tar.gz" \
  -C "$DIRECT_STAGE/app"

echo "[4/6] Adding direct-run launchers"
cp "$ROOT/deploy/ubuntu-portable/ensure_runtime.sh" "$DIRECT_STAGE/.ensure-runtime.sh"
cp "$ROOT/deploy/ubuntu-portable/run_web_direct.sh" "$DIRECT_STAGE/run-web.sh"
cp "$ROOT/deploy/ubuntu-portable/windrise_direct.sh" "$DIRECT_STAGE/windrise"
cp "$ROOT/deploy/ubuntu-portable/README_DIRECT.md" "$DIRECT_STAGE/README.md"
mkdir -p "$DIRECT_STAGE/deploy/seed"
cp "$ROOT/deploy/ensure-chat-users-db.sh" "$DIRECT_STAGE/deploy/ensure-chat-users-db.sh"
chmod +x "$DIRECT_STAGE/deploy/ensure-chat-users-db.sh"
if [[ -f "$ROOT/deploy/seed/chat_users.db" ]]; then
  cp "$ROOT/deploy/seed/chat_users.db" "$DIRECT_STAGE/deploy/seed/chat_users.db"
  seed_users="$(sqlite3 "$ROOT/deploy/seed/chat_users.db" "SELECT COUNT(*) FROM users;" 2>/dev/null || echo 0)"
  echo "Bundled chat_users seed: $seed_users users"
else
  echo "WARN: deploy/seed/chat_users.db missing; offline bundle will start with bootstrap admin only" >&2
fi
chmod +x \
  "$DIRECT_STAGE/.ensure-runtime.sh" \
  "$DIRECT_STAGE/run-web.sh" \
  "$DIRECT_STAGE/windrise" \
  "$DIRECT_STAGE/app/bin/windrise" \
  "$DIRECT_STAGE/app/bin/windrise-bash"

cat > "$DIRECT_STAGE/app/hn/.env.defaults" <<'EOF'
APP_HOST=0.0.0.0
APP_PORT=5002
DIFY_REQUIRED=0
WINDRISE_ENABLED=1
INIT_ADMIN_USERNAME=admin
INIT_ADMIN_PASSWORD=admin
VLLM_API_URL=http://127.0.0.1:9527/v1/chat/completions
VLLM_MODEL_NAME=Qwen-30B
LMSTUDIO_BASE_URL=http://127.0.0.1:9527
WINDRISE_MODEL_MODE=vllm
VLLM_AUTO_PROBE=1
WEB_THREADS=32
TARGET_CONCURRENCY=30
WEB_SERVER=auto
CHAT_DB_FILE=../data/chat_users.db
EOF

sensitive_file="$(find "$DIRECT_STAGE/app" -type f \( \
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

echo "[5/6] Writing direct-run bundle"
tar -czf "$BUNDLE" -C "$BUILD_ROOT" "$PACKAGE_NAME"

echo "[6/6] Writing checksum"
(
  cd "$OUT_DIR"
  shasum -a 256 "$(basename "$BUNDLE")" > "$(basename "$BUNDLE").sha256"
)

echo "$BUNDLE"
