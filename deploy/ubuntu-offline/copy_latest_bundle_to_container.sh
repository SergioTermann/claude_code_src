#!/usr/bin/env bash
set -euo pipefail

BUNDLE_DIR="${BUNDLE_DIR:-/0615}"
CONTAINER="${CONTAINER:-2797b7ba66be}"
TARGET_DIR="${TARGET_DIR:-/workspace}"
DOCKER_CMD="${DOCKER_CMD:-sudo docker}"

read -r -a DOCKER <<< "$DOCKER_CMD"

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
  done < <(find "$BUNDLE_DIR" -maxdepth 1 -type f -name '*.tar.gz' -print0)

  if [[ -z "$latest" ]]; then
    echo "ERROR: no .tar.gz bundle found in $BUNDLE_DIR" >&2
    exit 1
  fi

  printf '%s\n' "$latest"
}

bundle="$(find_latest_bundle)"
bundle_name="$(basename "$bundle")"

"${DOCKER[@]}" cp "$bundle" "$CONTAINER:$TARGET_DIR/"

cat <<EOF
Copied:
  $bundle -> $CONTAINER:$TARGET_DIR/$bundle_name

Next, enter Ubuntu with d and run:
  cd ${TARGET_DIR}
  tar -xzf ${bundle_name}
  rm -f ${bundle_name}
  cd \$(find . -maxdepth 2 -type f -name install_offline.sh -printf '%h\n' | head -n 1)
  bash install_offline.sh
  ./run-web.sh
EOF
