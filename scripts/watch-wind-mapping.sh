#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAPPING_FILE="${MAPPING_FILE:-$ROOT/风机故障码/故障信息整理/场站-型号映射表.xlsx}"
INTERVAL_SECONDS="${INTERVAL_SECONDS:-5}"

mtime_of() {
  if stat -f %m "$1" >/dev/null 2>&1; then
    stat -f %m "$1"
  else
    stat -c %Y "$1"
  fi
}

size_of() {
  if stat -f %z "$1" >/dev/null 2>&1; then
    stat -f %z "$1"
  else
    stat -c %s "$1"
  fi
}

signature_of() {
  printf '%s:%s' "$(mtime_of "$1")" "$(size_of "$1")"
}

if [[ ! -f "$MAPPING_FILE" ]]; then
  echo "ERROR: mapping file not found: $MAPPING_FILE" >&2
  exit 1
fi

last_signature="$(signature_of "$MAPPING_FILE")"
echo "[watch] mapping file: $MAPPING_FILE"
echo "[watch] interval: ${INTERVAL_SECONDS}s"
echo "[watch] initial signature: $last_signature"
echo "[watch] press Ctrl+C to stop"

while true; do
  sleep "$INTERVAL_SECONDS"

  if [[ ! -f "$MAPPING_FILE" ]]; then
    echo "[watch] mapping file disappeared, waiting: $MAPPING_FILE" >&2
    continue
  fi

  current_signature="$(signature_of "$MAPPING_FILE")"
  if [[ "$current_signature" == "$last_signature" ]]; then
    continue
  fi

  echo "[watch] change detected: $last_signature -> $current_signature"
  last_signature="$current_signature"

  if bash "$ROOT/scripts/reload-wind-mapping.sh"; then
    echo "[watch] reload succeeded at $(date '+%Y-%m-%d %H:%M:%S')"
  else
    echo "[watch] reload failed at $(date '+%Y-%m-%d %H:%M:%S')" >&2
  fi
done

