#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAPPING_FILE="${MAPPING_FILE:-$ROOT/风机故障码/故障信息整理/场站-型号映射表.xlsx}"

cd "$ROOT"

if [[ ! -f "$MAPPING_FILE" ]]; then
  echo "ERROR: mapping file not found: $MAPPING_FILE" >&2
  exit 1
fi

echo "[reload] mapping file: $MAPPING_FILE"
echo "[reload] rebuilding wind farm model table..."
npm run build:wind-farm-models -- "$MAPPING_FILE"

echo "[reload] rebuilding turbine mapping..."
npm run build:turbine-mapping -- "$MAPPING_FILE"

echo "[reload] rebuilding fault index..."
npm run build:fault-index

echo "[reload] rebuilding wind llmwiki..."
npm run build:wind-llmwiki

echo "[reload] done."
echo "[reload] updated:"
ls -lh \
  "$ROOT/风机故障码/fault-index.jsonl" \
  "$ROOT/风机故障码/fault-index-summary.json" \
  "$ROOT/src/data/windFarmModels.json" \
  "$ROOT/src/data/turbineMapping.json" \
  "$ROOT/wind-llmwiki/fault-index.jsonl" \
  "$ROOT/wind-llmwiki/fault-index-summary.json"
