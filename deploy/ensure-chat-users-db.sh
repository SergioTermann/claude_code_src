#!/usr/bin/env bash
# Seed or restore chat_users.db from deploy/seed/chat_users.db (114 users).
# Called by run-web launchers before starting dify_web_server_.py.
set -euo pipefail

HN_DIR="${1:?hn directory required}"
RUNTIME_ROOT="${2:-$(cd "$HN_DIR/.." && pwd)}"

find_seed_db() {
  local candidate
  for candidate in \
    "$RUNTIME_ROOT/deploy/seed/chat_users.db" \
    "$RUNTIME_ROOT/../deploy/seed/chat_users.db" \
    "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/seed/chat_users.db"
  do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

count_users() {
  local db_path="$1"
  if [[ ! -f "$db_path" ]]; then
    echo 0
    return 0
  fi
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$db_path" "SELECT COUNT(*) FROM users;" 2>/dev/null || echo 0
    return 0
  fi
  "$RUNTIME_ROOT/runtime/conda/bin/python" - <<'PY' "$db_path"
import sqlite3
import sys

try:
    conn = sqlite3.connect(sys.argv[1])
    print(conn.execute("SELECT COUNT(*) FROM users").fetchone()[0])
except Exception:
    print(0)
PY
}

SEED_DB=""
if SEED_DB="$(find_seed_db)"; then
  :
else
  echo "[users] no seed chat_users.db found under deploy/seed/, skipping"
  exit 0
fi

SEED_COUNT="$(count_users "$SEED_DB")"
if [[ "$SEED_COUNT" -le 0 ]]; then
  echo "[users] seed database is empty: $SEED_DB"
  exit 0
fi

RUNTIME_DATA_DIR="${RUNTIME_ROOT}/data"
TARGET_DB="${CHAT_DB_FILE:-$RUNTIME_DATA_DIR/chat_users.db}"
if [[ "$TARGET_DB" != /* ]]; then
  TARGET_DB="$(cd "$HN_DIR" && cd "$(dirname "$TARGET_DB")" && pwd)/$(basename "$TARGET_DB")"
fi
mkdir -p "$(dirname "$TARGET_DB")"

TARGET_COUNT=0
if [[ -f "$TARGET_DB" ]]; then
  TARGET_COUNT="$(count_users "$TARGET_DB")"
fi

RESTORE="${WINDRISE_RESTORE_CHAT_USERS:-0}"
MIN_USERS="${WINDRISE_CHAT_USERS_MIN_COUNT:-10}"

backup_target_db() {
  local stamp
  stamp="$(date +%Y%m%d_%H%M%S)"
  cp "$TARGET_DB" "${TARGET_DB}.bak.${stamp}"
  echo "[users] backed up existing db -> ${TARGET_DB}.bak.${stamp}"
}

install_seed_db() {
  cp "$SEED_DB" "$TARGET_DB"
  echo "[users] installed $SEED_COUNT users from seed -> $TARGET_DB"
}

if [[ "$RESTORE" == "1" ]]; then
  if [[ -f "$TARGET_DB" ]]; then
    backup_target_db
  fi
  install_seed_db
elif [[ ! -f "$TARGET_DB" ]] || [[ "$TARGET_COUNT" -le 1 ]]; then
  install_seed_db
elif [[ "$TARGET_COUNT" -lt "$MIN_USERS" && "$SEED_COUNT" -ge "$MIN_USERS" ]]; then
  backup_target_db
  install_seed_db
else
  echo "[users] keeping existing db ($TARGET_COUNT users) at $TARGET_DB"
fi
