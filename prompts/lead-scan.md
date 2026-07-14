---
description: 执行CSP商机发掘扫描
argument-hint: "<scenario>"
---
执行 $1 场景的商机发掘扫描。

1. 使用 /skill:$1 加载场景 skill，按其 SKILL.md 指令执行完整 pipeline
2. 首先确保 browser-executor skill 已就绪（如未加载则先 /skill:browser-executor）
3. **Phase 0**: 读取 `config/search-config.json`，检查 `search_mode`：
   - `"full"` → 全量模式：重置所有搜索状态，重新搜索两个数据源。搜索完成后自动改回 `"incremental"`
   - `"incremental"` → 增量模式：仅搜索未完成的 API × 数据源组合
4. 按场景 SKILL.md 的阶段依次执行：
   - Phase 1: FDA 数据采集与缓存
   - Phase 2: 双源临床试验搜索（chinadrugtrials + ClinicalTrials.gov，两个来源独立跟踪）
   - Phase 3: 报告生成（含企业联系方式、产品名称、药物分类）
5. 如遇到网页加载失败或验证码：
   - 交互模式：暂停并向用户说明情况，等待指示
   - 自动模式（pi -p）：截图保存，记录错误，继续下一个API
6. 完成后输出 output/CSP_Leads_Report.md 的路径，并简要总结新增商机数量

## 代码安全约束

- 所有 wait 步骤必须设置 timeout，禁止无限等待
- 禁止使用 while(true) 等无限循环
- 每个 extract 步骤的输出必须是结构化 JSON
- 单个 browser script 执行时间不超过 120 秒

## 全量搜索触发方式

编辑 `config/search-config.json`，将 `"search_mode"` 改为 `"full"`，然后执行 `/lead-scan nitrosamine`。
首次上线部署时建议使用全量搜索，之后日常运行使用增量模式。
