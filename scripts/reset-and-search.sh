#!/bin/bash
# 从零开始：清空场景缓存 → 全量搜索 → 生成报告
# 用法: bash scripts/reset-and-search.sh [scenario]   # 默认 nitrosamine
#
# 会做什么：
#   1. 读取 scenarios/<scenario>/scenario.json，定位该场景的缓存文件
#   2. 删除该缓存文件（API 列表 + 搜索状态 + 试验结果）
#   3. 清空 output/runs/ 下所有快照和日志
#   4. 将 config/search-config.json 的 search_mode 改为 full（保留其他字段）
#   5. 后台启动 pipeline（CT.gov ~5分钟 + CDT ~2-3小时）
#
# 完成后：
#   - 报告中不会出现"新增商机"板块（无前次快照对比，无意义）
#   - 只有"全量商机列表"
#   - search_mode 自动改回 incremental

set -e
WS=/workspace
SCENARIO="${1:-nitrosamine}"
SCENARIO_DIR="$WS/scenarios/$SCENARIO"

if [[ ! -f "$SCENARIO_DIR/scenario.json" ]]; then
  echo "ERROR: 场景不存在: scenarios/$SCENARIO/scenario.json"
  exit 1
fi

# 从 scenario.json 读取缓存文件路径
CACHE_FILE=$(node -e "console.log(require('$SCENARIO_DIR/scenario.json').cache_file)")
REPORT_FILE=$(node -e "console.log(require('$SCENARIO_DIR/scenario.json').report_file)")
SEARCH_CONFIG="$WS/config/search-config.json"

echo "════════════════════════════════════"
echo "  CSP Pipeline — 从零全量搜索"
echo "  场景: $SCENARIO"
echo "════════════════════════════════════"
echo ""

# 确认
read -p "确认清空 $SCENARIO 场景的所有旧数据并重新搜索？(y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "已取消"
  exit 0
fi

echo "[1/4] 清空场景缓存..."
rm -f "$WS/$CACHE_FILE"
echo "  ✓ 已删除 $CACHE_FILE"

echo "[2/4] 清空运行快照和日志..."
rm -f "$WS/output/runs/"*.json
rm -f "$WS/output/runs/"*.log
echo "  ✓ 已清空 output/runs/"

echo "[3/4] 设置全量搜索模式..."
node -e "
const fs=require('fs');
const p='$SEARCH_CONFIG';
const cfg=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):{};
cfg.search_mode='full';
fs.writeFileSync(p, JSON.stringify(cfg,null,2));
"
echo "  ✓ search_mode = full"

echo "[4/4] 启动 pipeline（后台运行）..."
echo "  日志: output/runs/pipeline.log"
echo ""
nohup node "$WS/scripts/run-pipeline.js" "$SCENARIO" > "$WS/output/runs/pipeline.log" 2>&1 &
PID=$!
echo "  PID: $PID"
echo ""
echo "════════════════════════════════════"
echo "  已启动！监控命令："
echo "  tail -f output/runs/pipeline.log"
echo ""
echo "  检查是否完成："
echo "  kill -0 $PID 2>/dev/null && echo 运行中 || echo 已完成"
echo "════════════════════════════════════"
