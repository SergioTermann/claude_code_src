#!/usr/bin/env bash
set -euo pipefail

LABEL="com.windrise.web"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 || true
rm -f "$PLIST_PATH"

echo "已卸载 Windrise Web 登录自启服务。"
