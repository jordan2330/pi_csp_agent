#!/usr/bin/env bash
# 读取最新报告的头部摘要，推送到企业微信/钉钉群机器人
# 用法: ./scripts/notify.sh [report_path]
# 环境变量: WEBHOOK_URL (企业微信或钉钉的 Webhook 地址)

set -euo pipefail

REPORT_PATH="${1:-output/CSP_Leads_Report.md}"
WEBHOOK_URL="${WEBHOOK_URL:-}"

if [ -z "$WEBHOOK_URL" ]; then
  echo "WEBHOOK_URL not set, skipping notification"
  exit 0
fi

if [ ! -f "$REPORT_PATH" ]; then
  echo "Report not found: $REPORT_PATH"
  exit 1
fi

# 提取报告头部信息（前20行）
SUMMARY=$(head -20 "$REPORT_PATH" | sed 's/"/\\"/g' | sed ':a;N;$!ba;s/\n/\\n/g')

# 生成日期
DATE=$(date +%Y-%m-%d)

# 构造消息内容
# 企业微信和钉钉都支持 markdown 类型消息
PAYLOAD=$(cat <<EOF
{
  "msgtype": "markdown",
  "markdown": {
    "content": "🔔 **Aptar CSP AI 侦探本周简报** ($DATE)\n\n$SUMMARY\n\n[查看完整报告]($REPORT_PATH)"
  }
}
EOF
)

# 发送到企业微信或钉钉
curl -s -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD"

echo ""
echo "Notification sent to $WEBHOOK_URL"
