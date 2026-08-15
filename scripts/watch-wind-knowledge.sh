#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WATCH_DIR="${WATCH_DIR:-$ROOT/风机故障码}"
INTERVAL_SECONDS="${INTERVAL_SECONDS:-5}"

signature_of() {
  find "$WATCH_DIR" \
    -type f \( -name '*.md' -o -name '*.xlsx' \) \
    ! -path '*/.~lock.*' \
    -print0 \
    | sort -z \
    | xargs -0 stat -c '%n:%Y:%s' 2>/dev/null \
    | sha256sum \
    | awk '{print $1}'
}

if [[ ! -d "$WATCH_DIR" ]]; then
  echo "ERROR: watch dir not found: $WATCH_DIR" >&2
  exit 1
fi

last_signature="$(signature_of)"
echo "[watch] wind knowledge dir: $WATCH_DIR"
echo "[watch] interval: ${INTERVAL_SECONDS}s"
echo "[watch] initial signature: $last_signature"
echo "[watch] watching *.md and *.xlsx; press Ctrl+C to stop"

while true; do
  sleep "$INTERVAL_SECONDS"

  current_signature="$(signature_of)"
  if [[ "$current_signature" == "$last_signature" ]]; then
    continue
  fi

  echo "[watch] change detected: $last_signature -> $current_signature"
  last_signature="$current_signature"

  if bash "$ROOT/scripts/reload-wind-knowledge.sh"; then
    echo "[watch] reload succeeded at $(date '+%Y-%m-%d %H:%M:%S')"
  else
    echo "[watch] reload failed at $(date '+%Y-%m-%d %H:%M:%S')" >&2
  fi
done
