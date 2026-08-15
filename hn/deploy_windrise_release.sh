#!/usr/bin/env bash
# Bump deploy version, run regression gates, and print production checklist.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

RUN_TESTS="${WINDRISE_RUN_TESTS:-1}"
SKIP_BROWSER="${SKIP_BROWSER_TESTS:-0}"

echo "== Step 1/3: bump build id =="
"${SCRIPT_DIR}/bump_windrise_build_id.sh"
BUILD_ID="$(tr -d '\n' < "${SCRIPT_DIR}/.windrise_build_id")"

if [[ "${RUN_TESTS}" == "1" ]]; then
  echo ""
  echo "== Step 2/3: regression gates =="
  ./run_full_regression.sh
  if [[ "${SKIP_BROWSER}" != "1" ]]; then
    echo ""
    echo "== Extended API + browser regression =="
    SKIP_BROWSER_TESTS="${SKIP_BROWSER}" python3 run_extended_regression_tests.py
  else
    echo ""
    echo "== Extended API regression (browser skipped) =="
    SKIP_BROWSER_TESTS=1 python3 run_extended_regression_tests.py
  fi
else
  echo ""
  echo "== Step 2/3: tests skipped (WINDRISE_RUN_TESTS=0) =="
fi

echo ""
echo "== Step 3/3: production checklist =="
cat <<EOF

Windrise release ready: ${BUILD_ID}

IMPORTANT: restart the running Web server so code changes take effect.
  pkill -f dify_web_server_.py   # or restart your systemd service
  cd hn && ./run_windrise_web.sh

Deploy checklist:
  1. Copy updated hn/ tree (or full bundle) to the target server.
  2. Ensure hn/.windrise_build_id contains: ${BUILD_ID}
  3. Restart the web service:
       cd hn && ./run_windrise_web.sh
     or restart systemd unit if configured.
  4. Verify version endpoint:
       curl -s http://<host>:5002/api/app-version
  5. Hard-refresh browsers (Cmd+Shift+R / Ctrl+Shift+R).
  6. Confirm UI shows 流式响应: 关 for stability (optional but recommended).
  7. Smoke test login + one scoped fault query (e.g. 同发风场A32号风机 SS-4刹车存储继电器).

Optional post-deploy checks:
  - python3 run_windrise_scenario_experiments.py
  - WINDRISE_BROWSER_EXPERIMENTS=1 ./run_full_regression.sh
  - WINDRISE_EXTENDED_REGRESSION=1 ./run_full_regression.sh

EOF
