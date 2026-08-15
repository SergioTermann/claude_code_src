#!/usr/bin/env bash
set -euo pipefail

ROOT="${ROOT:-/workspace}"

find_latest_bundle() {
  local latest=""
  local latest_mtime=-1

  while IFS= read -r -d '' file; do
    local mtime
    mtime="$(stat -c '%Y' "$file")"
    if (( mtime > latest_mtime )); then
      latest_mtime="$mtime"
      latest="$file"
    fi
  done < <(find "$ROOT" -maxdepth 1 -type f -name '*.tar.gz' -print0)

  if [[ -z "$latest" ]]; then
    echo "ERROR: no .tar.gz bundle found in $ROOT" >&2
    exit 1
  fi

  printf '%s\n' "$latest"
}

find_install_dir() {
  local install_file=""

  install_file="$(find "$ROOT" -maxdepth 2 -type f -name install_offline.sh -print | head -n 1)"
  if [[ -z "$install_file" ]]; then
    echo "ERROR: cannot locate install_offline.sh under $ROOT" >&2
    exit 1
  fi

  dirname "$install_file"
}

bundle="$(find_latest_bundle)"

echo "[1/4] Extracting $(basename "$bundle")"
tar -xzf "$bundle" -C "$ROOT"

echo "[2/4] Removing archive"
rm -f "$bundle"

workdir="$(find_install_dir)"
cd "$workdir"

echo "[3/4] Running install_offline.sh"
bash install_offline.sh

echo "[4/4] Install complete (Web not started)"
if [[ "${START_WEB:-0}" == "1" ]]; then
  echo "[5/5] Starting Web UI"
  exec ./run-web.sh
fi

cat <<EOF

解压/安装已完成，未自动启动 Web（不占 5002 端口）。

需要时再启动:
  cd "$workdir"
  ./run-web.sh

或一键安装并启动:
  START_WEB=1 bash install_latest_bundle_and_run.sh
EOF
