#!/usr/bin/env bash
# Windrise 部署诊断脚本
# 用法（在 Web 应用服务器上执行）：
#   chmod +x diagnose-windrise-deployment.sh
#   ./diagnose-windrise-deployment.sh
#
# 可选环境变量：
#   VLLM_HOST=10.46.161.210   GPU / vLLM 机器 IP
#   VLLM_PORT=9527
#   WEB_PORT=5002
#   WINDRISE_DIR=/opt/windrise-ubuntu   部署根目录（自动探测 hn/.env）

set -u

VLLM_HOST="${VLLM_HOST:-10.46.161.210}"
VLLM_PORT="${VLLM_PORT:-9527}"
WEB_PORT="${WEB_PORT:-5002}"
VLLM_BASE_URL="http://${VLLM_HOST}:${VLLM_PORT}"
VLLM_MODELS_URL="${VLLM_BASE_URL}/v1/models"
VLLM_CHAT_URL="${VLLM_BASE_URL}/v1/chat/completions"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -n "${WINDRISE_DIR:-}" ]]; then
  PROJECT_DIR="$WINDRISE_DIR"
elif [[ -d "$SCRIPT_DIR/app/hn" ]]; then
  PROJECT_DIR="$SCRIPT_DIR/app"
elif [[ -d "$SCRIPT_DIR/hn" ]]; then
  PROJECT_DIR="$SCRIPT_DIR"
elif [[ -d "$SCRIPT_DIR/windrise/hn" ]]; then
  PROJECT_DIR="$SCRIPT_DIR/windrise"
else
  PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
fi
HN_DIR="${HN_DIR:-$PROJECT_DIR/hn}"
ENV_FILE="${ENV_FILE:-$HN_DIR/.env}"
OUT_LOG="${OUT_LOG:-$HN_DIR/logs/windrise-web.out.log}"
ERR_LOG="${ERR_LOG:-$HN_DIR/logs/windrise-web.err.log}"

PASS=0
WARN=0
FAIL=0

section() {
  echo ""
  echo "============================================================"
  echo "$1"
  echo "============================================================"
}

ok()   { echo "[OK]   $*"; PASS=$((PASS + 1)); }
warn() { echo "[WARN] $*"; WARN=$((WARN + 1)); }
bad()  { echo "[FAIL] $*"; FAIL=$((FAIL + 1)); }

run_curl() {
  local url="$1"
  local label="$2"
  local timeout="${3:-5}"
  local tmp
  tmp="$(mktemp)"
  if curl -sS -m "$timeout" -o "$tmp" -w "HTTP %{http_code} time %{time_total}s\n" "$url" 2>&1 | tee /dev/stderr | grep -qE '^HTTP 2'; then
    ok "$label 可访问 ($url)"
    head -c 300 "$tmp" 2>/dev/null | sed 's/^/       /'
    echo ""
  else
    bad "$label 不可访问 ($url)"
    cat "$tmp" 2>/dev/null | head -5 | sed 's/^/       /'
  fi
  rm -f "$tmp"
}

section "0. 本机信息"
echo "时间:     $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "主机名:   $(hostname 2>/dev/null || echo unknown)"
echo "项目目录: $PROJECT_DIR"
echo "hn 目录:  $HN_DIR"
echo "vLLM:     $VLLM_BASE_URL"
echo "Web 端口: $WEB_PORT"

section "1. vLLM 可达性（从本 Web 服务器出发）"
echo ">>> 这是最关键的一项：Web 必须能访问 GPU 机上的 vLLM"
run_curl "$VLLM_MODELS_URL" "vLLM /v1/models" 5

section "2. Windrise Web 服务"
run_curl "http://10.46.161.210:${WEB_PORT}/health" "Web /health" 3

echo ""
echo "--- 端口 ${WEB_PORT} 监听情况 ---"
if command -v ss >/dev/null 2>&1; then
  ss -lntp 2>/dev/null | grep ":${WEB_PORT} " || warn "端口 ${WEB_PORT} 未监听"
elif command -v lsof >/dev/null 2>&1; then
  lsof -nP -iTCP:"${WEB_PORT}" -sTCP:LISTEN 2>/dev/null || warn "端口 ${WEB_PORT} 未监听"
else
  warn "未找到 ss/lsof，跳过端口检查"
fi

echo ""
echo "--- 5002 是否被多个进程占用 ---"
if command -v lsof >/dev/null 2>&1; then
  COUNT="$(lsof -t -i :"${WEB_PORT}" 2>/dev/null | wc -l | tr -d ' ')"
  if [[ "${COUNT:-0}" -gt 1 ]]; then
    bad "端口 ${WEB_PORT} 有 ${COUNT} 个进程，可能存在旧进程未退出（会导致跑旧代码）"
    lsof -nP -i :"${WEB_PORT}" 2>/dev/null | sed 's/^/       /'
  elif [[ "${COUNT:-0}" -eq 1 ]]; then
    ok "端口 ${WEB_PORT} 仅 1 个进程监听"
  else
    warn "端口 ${WEB_PORT} 无监听进程"
  fi
fi

section "3. 环境变量 / .env"
if [[ -f "$ENV_FILE" ]]; then
  ok "找到 $ENV_FILE"
  grep -E '^(VLLM_API_URL|VLLM_MODEL_NAME|LMSTUDIO_BASE_URL|APP_HOST|APP_PORT|WINDRISE_)' "$ENV_FILE" 2>/dev/null | sed 's/^/       /'
else
  warn "未找到 $ENV_FILE，请设置 WINDRISE_DIR 或 HN_DIR"
fi

echo ""
echo "--- Web 进程工作目录 ---"
WEB_PID="$(lsof -t -i :"${WEB_PORT}" 2>/dev/null | head -1 || true)"
if [[ -n "${WEB_PID:-}" ]] && [[ -e "/proc/$WEB_PID/cwd" ]]; then
  readlink -f "/proc/$WEB_PID/cwd" 2>/dev/null | sed 's/^/       /'
elif [[ -n "${WEB_PID:-}" ]]; then
  echo "       PID=$WEB_PID"
fi

echo ""
echo "--- 当前进程环境（若在运行） ---"
if [[ -n "${WEB_PID:-}" ]] && [[ -r "/proc/$WEB_PID/environ" ]]; then
  tr '\0' '\n' < "/proc/$WEB_PID/environ" | grep -E '^(VLLM_API_URL|LMSTUDIO_BASE_URL|APP_HOST|APP_PORT)=' | sed 's/^/       /'
elif [[ -n "${WEB_PID:-}" ]]; then
  warn "Web PID=$WEB_PID，但无法读取 /proc 环境（非 Linux 可忽略）"
else
  warn "Web 未运行，跳过进程环境检查"
fi

section "4. 最近日志（连接超时 / 流式 / vLLM）"
for LOG in "$OUT_LOG" "$ERR_LOG"; do
  echo ""
  echo "--- $LOG (最近 40 条相关) ---"
  if [[ -f "$LOG" ]]; then
    grep -E 'timed out|语义模型暂不可用|语义路由|流式兼容回复完成|LLMWiki|Address already in use|Connection to' "$LOG" 2>/dev/null | tail -40 | sed 's/^/       /' || echo "       (无匹配行)"
  else
    warn "日志不存在: $LOG"
  fi
done

section "5. 流式中断风险快速判断"
if [[ -f "$OUT_LOG" ]]; then
  TIMEOUT_COUNT="$(grep -c 'timed out' "$OUT_LOG" 2>/dev/null || echo 0)"
  ADDR_IN_USE="$(grep -c 'Address already in use' "$OUT_LOG" 2>/dev/null || echo 0)"
  if [[ "$TIMEOUT_COUNT" -gt 0 ]]; then
    bad "日志中有 ${TIMEOUT_COUNT} 次 vLLM 连接超时 → 易导致前端「回答连接在传输过程中中断」"
  else
    ok "近期日志未见 vLLM 连接超时"
  fi
  if [[ "$ADDR_IN_USE" -gt 0 ]]; then
    warn "日志中有 ${ADDR_IN_USE} 次端口占用 → 建议 kill 旧进程后只保留一个 Web 实例"
  fi
fi

section "6. 可选：一次最小 chat 流式探测"
echo "向本机 Web 发一条流式请求（需已登录会话时可能返回 401，属正常）"
CHAT_TMP="$(mktemp)"
HTTP_CODE="$(curl -sS -m 15 -o "$CHAT_TMP" -w '%{http_code}' \
  -X POST "http://10.46.161.210:${WEB_PORT}/api/chat" \
  -H 'Content-Type: application/json' \
  -d '{"message":"ping","response_mode":"streaming","session_id":1}' 2>/dev/null || echo 000)"
echo "       HTTP $HTTP_CODE"
head -c 400 "$CHAT_TMP" 2>/dev/null | sed 's/^/       /'
rm -f "$CHAT_TMP"
if [[ "$HTTP_CODE" == "401" ]]; then
  ok "Web 在响应（401=未登录，服务本身正常）"
elif [[ "$HTTP_CODE" == "403" ]]; then
  ok "Web 在响应（403=CSRF/未登录，curl 探测属正常，请用浏览器登录后测试）"
elif [[ "$HTTP_CODE" == "200" ]]; then
  ok "Web chat 接口返回 200"
else
  warn "chat 探测 HTTP $HTTP_CODE（可能未启动或路由异常）"
fi

section "7. GPU 机（10.46.161.210）上需人工执行的命令"
cat <<EOF

在 GPU / vLLM 服务器 (${VLLM_HOST}) 上执行：

  # vLLM 是否监听 9527（应对外网卡，不能只绑定本机回环地址）
  ss -lntp | grep ${VLLM_PORT}

  # 本机自测
  curl -m 3 http://10.46.161.210:${VLLM_PORT}/v1/models

  # 防火墙：放行 Web 服务器 IP → ${VLLM_PORT}
  # Ubuntu 示例（把 WEB_SERVER_IP 换成实际 Web 机内网 IP）：
  # sudo ufw allow from WEB_SERVER_IP to any port ${VLLM_PORT}

EOF

section "8. 汇总"
echo "通过: $PASS   警告: $WARN   失败: $FAIL"
echo ""
if [[ "$FAIL" -gt 0 ]]; then
  echo ">>> 诊断发现失败项。最常见原因："
  echo "    1) Web 服务器访问不了 ${VLLM_BASE_URL}"
  echo "    2) vLLM 只绑定了本机回环地址 或防火墙未放行"
  echo "    3) 多个 Web 进程 / 未部署含流式保活的最新代码"
  echo ""
  echo "修复后请："
  echo "    - 重启 Web: systemctl restart windrise-web  或 kill 5002 后重新启动"
  echo "    - 浏览器硬刷新 (Cmd+Shift+R / Ctrl+Shift+R)"
  exit 1
fi

if [[ "$WARN" -gt 0 ]]; then
  echo ">>> 有警告项，建议逐项确认。"
  exit 2
fi

echo ">>> 基础检查通过。若仍出现流式中断，请把本脚本完整输出和出错时的问题原文一并反馈。"
exit 0
