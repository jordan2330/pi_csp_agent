#!/bin/bash
# 429 限流监控脚本
echo "=== 429 限流监控 $(date '+%H:%M:%S') ==="

# 检查 errors.log
if [ -f /workspace/output/runs/errors.log ]; then
  ERR_COUNT=$(grep -ciE '429|Too Many|限流|WebSocket error' /workspace/output/runs/errors.log 2>/dev/null || true)
  echo "errors.log 中 429/限流/WebSocket 错误: ${ERR_COUNT:-0} 条"
  if [ "${ERR_COUNT:-0}" -gt 0 ] 2>/dev/null; then
    echo "--- 最近 5 条错误 ---"
    grep -iE '429|Too Many|限流|WebSocket error' /workspace/output/runs/errors.log 2>/dev/null | tail -5
  fi
else
  echo "errors.log 不存在"
fi

# pipeline 进度
echo ""
echo "--- pipeline 最新 5 行 ---"
tail -5 /workspace/output/runs/pipeline.log 2>/dev/null

# 文件是否在增长（判断是否还在运行）
SIZE1=$(wc -c < /workspace/output/runs/pipeline.log 2>/dev/null)
sleep 2
SIZE2=$(wc -c < /workspace/output/runs/pipeline.log 2>/dev/null)
echo ""
if [ "$SIZE2" -gt "$SIZE1" ] 2>/dev/null; then
  echo "状态: ✅ pipeline 仍在运行 (${SIZE2} bytes)"
else
  echo "状态: ⛔ pipeline 可能已结束 (${SIZE2} bytes, 2s 内无变化)"
fi
