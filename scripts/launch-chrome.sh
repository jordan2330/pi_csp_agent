#!/bin/bash
# 启动 Windows 侧专用 profile Chrome，并开放 CDP 调试端点（供 WSL 内的 pipeline 通过 CDP 连接）
#
# 为什么需要：CDT（chinadrugtrials.org.cn）已启用瑞数动态安全，headless/自动化浏览器会被拦截，
#             必须用真实浏览器。此脚本启动的是 Windows 上真实的 Chrome（专用 profile，不影响日常浏览）。
#
# 前置条件：WSL 需 mirrored 网络模式（.wslconfig 里 networkingMode=mirrored），
#           否则 WSL 访问不到 Windows 的 127.0.0.1。
#
# 用法：
#   bash scripts/launch-chrome.sh                    # 已在运行则直接返回
#   CDT_CDP_PORT=9223 bash scripts/launch-chrome.sh  # 自定义端口
#   CDP_CHROME_EXE=/mnt/c/.../chrome.exe bash scripts/launch-chrome.sh
set -u

PORT="${CDT_CDP_PORT:-9223}"
PROFILE_WIN="${CDT_CHROME_PROFILE:-C:\\cdt-profile}"
ENDPOINT="http://127.0.0.1:${PORT}/json/version"

# ── 已在运行？──
if curl -s -o /dev/null --max-time 3 "$ENDPOINT"; then
  echo "✅ Chrome 已在运行（CDP 端口 ${PORT}）"
  exit 0
fi

# ── 定位 Windows 版 Chrome ──
CANDIDATES=(
  "${CDP_CHROME_EXE:-}"
  "$(ls -d /mnt/c/Users/*/AppData/Local/Google/Chrome/Application/chrome.exe 2>/dev/null | head -1)"
  "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
  "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"
)
CHROME=""
for c in "${CANDIDATES[@]}"; do
  [ -n "$c" ] && [ -x "$c" ] && CHROME="$c" && break
done

if [ -z "$CHROME" ]; then
  echo "❌ 未找到 Windows 版 Chrome。"
  echo "   可用 CDP_CHROME_EXE=/mnt/c/.../chrome.exe 显式指定。"
  exit 1
fi

echo "启动 Chrome: $CHROME"
echo "  profile: $PROFILE_WIN    CDP 端口: $PORT"
"$CHROME" --user-data-dir="$PROFILE_WIN" --remote-debugging-port="$PORT" \
  --no-first-run --no-default-browser-check >/dev/null 2>&1 &

# ── 等待端点就绪 ──
for _ in $(seq 1 20); do
  sleep 1
  if curl -s -o /dev/null --max-time 2 "$ENDPOINT"; then
    echo "✅ CDP 端点就绪: http://127.0.0.1:${PORT}"
    exit 0
  fi
done

echo "⚠️ 等待超时。常见原因："
echo "   1. 该 profile 已有一个 Chrome 窗口在运行（同 profile 启动会复用到已有进程，调试开关失效）"
echo "      → 关掉该 Chrome 窗口后重跑本脚本"
echo "   2. WSL 不是 mirrored 网络模式 → 检查 ~/.wslconfig"
exit 1