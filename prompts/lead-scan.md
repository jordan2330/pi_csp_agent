---
description: 执行CSP商机发掘扫描
argument-hint: "<scenario>"
---
执行 $1 场景的商机发掘扫描。

## 执行流程

1. 使用 /skill:$1 加载场景 skill
2. 如未加载 browser-executor skill，先 /skill:browser-executor

### Phase 0: 环境检查
- 读取 `config/search-config.json`，确认搜索模式（full 或 incremental）
- 检查 `config/fda_nitrosamines.json` 是否存在且非空

### Phase 1: FDA 数据
- 如果 FDA 缓存已存在（apis 数量 > 0），跳过采集，直接进入 Phase 2
- 如果缓存不存在或为空，按 SKILL.md Phase 1 指引用浏览器抓取 FDA 页面，生成缓存文件

### Phase 2+3: 搜索 + 报告（自动化）
- **直接执行 pipeline 脚本**，不要手动逐个 API 搜索
- 由于 CDT 浏览器搜索可能耗时 2-3 小时，必须使用**后台执行 + 轮询**：
  ```bash
  nohup node scripts/run-pipeline.js "$1" > /workspace/output/runs/pipeline.log 2>&1 &
  ```
- 每隔 2 分钟检查：`tail -5 /workspace/output/runs/pipeline.log` + `kill -0 <PID>` 判断是否完成
- 如果待搜索 API 为 0（增量模式），pipeline 会秒级完成，可先同步尝试
- 脚本自动完成：CT.gov REST API 搜索 → CDT 浏览器搜索 → 快照生成 → 报告生成
- 全量模式下搜索完成会自动将 search_mode 改回 incremental

### 完成后
- 读取 `output/CSP_Leads_Report.md` 的概览部分，输出简要总结
- 检查 `output/runs/errors.log`，汇报失败的 API（如有）
- 报告文件路径：`output/CSP_Leads_Report.md`

## 代码安全约束

- 所有 wait 步骤必须设置 timeout，禁止无限等待
- 禁止使用 while(true) 等无限循环
- 每个 extract 步骤的输出必须是结构化 JSON
- 单个 browser script 执行时间不超过 120 秒
