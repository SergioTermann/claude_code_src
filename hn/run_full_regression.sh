#!/usr/bin/env bash
# One-command Windrise regression gate (unit + scenario experiments).
set -euo pipefail

cd "$(dirname "$0")"

echo "== Windrise unit tests =="
python3 -m unittest discover -s . -p 'test_windrise*.py' -q

echo ""
echo "== Windrise scenario experiments =="
python3 run_windrise_scenario_experiments.py

if [[ "${WINDRISE_EXTENDED_REGRESSION:-0}" == "1" ]]; then
  echo ""
  echo "== Extended API + browser regression =="
  SKIP_BROWSER_TESTS="${SKIP_BROWSER_TESTS:-0}" python3 run_extended_regression_tests.py
fi

if [[ "${WINDRISE_BROWSER_EXPERIMENTS:-0}" == "1" ]]; then
  echo ""
  echo "== Windrise browser scenario experiments =="
  python3 run_windrise_browser_experiments.py
fi

echo ""
echo "All regression gates passed."
