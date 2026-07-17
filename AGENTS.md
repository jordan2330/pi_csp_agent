# AGENTS.md

## Project Overview

This is a Pi Coding Agent project for CSP (Aptar active packaging) sales lead discovery. The agent scrapes regulatory and clinical trial data, matches customer profiles, and generates Markdown lead reports.

## LLM Configuration

- Provider: Aliyun DashScope (百炼) via OpenAI-compatible API
- Endpoint: `https://dashscope.aliyuncs.com/compatible-mode/v1`
- Models: `qwen3.7-max` / `deepseek-v4-pro` / `glm-5.2` / `kimi-k2.6` for complex reasoning, `qwen3.7-plus` / `deepseek-v4-flash` for routine tasks
- Config: `config/models.json` → mounted to `/home/piuser/.pi/agent/models.json` in Docker (容器以宿主机 UID 运行，非 root)
- API key: `DASHSCOPE_API_KEY` environment variable
- All models use `thinkingFormat: "qwen"` (Aliyun unified endpoint)

## Project Structure

- `skills/browser_executor/` — Generic Playwright browser automation tool (shared across all scenarios)
  - `scripts/browser.js` — Playwright 封装（navigate/type/click/wait/select/evaluate/delay/loop/extract/screenshot）
  - `scripts/cdt-search.js` — chinadrugtrials.org.cn 专用搜索脚本（增量游标 + 详情页提取）
- `scenarios/` — Business scenario skills (nitrosamine, probiotics, IVD, etc.)
  - `scenarios/<name>/SKILL.md` — 场景指令（pipeline 编排）
  - `scenarios/<name>/scenario.json` — 声明式配置（表头列、CSP推荐矩阵、缓存/报告路径）
  - `scenarios/<name>/enrich.js` — 场景专属 hooks（药物分类、CSP推荐、报告小标题等）
- `scripts/` — Pipeline 自动化脚本
  - `run-pipeline.js` — 主编排器（Phase 2+3：双源搜索 → 快照 → 报告）
  - `reset-and-search.sh` — 从零全量重置脚本
  - `lib/sources.js` — 数据源统一接口（CT.gov REST API + CDT 浏览器脚本）
  - `lib/enrichment.js` — 剂型检测（英文/中文）、产品名提取
  - `lib/snapshot.js` — 快照管理 + 增量检测
  - `lib/report.js` — 通用 Markdown 报告渲染器（由 scenario.json + enrich.js 驱动）
- `prompts/` — Pi prompt templates (entry points like `/lead-scan`)
- `config/` — Cached data and model configuration
  - `models.json` — LLM 模型配置
  - `api_translations.json` — API 英文名→中文名映射表
  - `search-config.json` — 搜索模式控制（full / incremental）
  - `fda_nitrosamines.json` — FDA 缓存（运行时生成，不纳入版本控制）
- `output/` — Generated reports and run snapshots
  - `CSP_Leads_Report.md` — 最终商机报告
  - `runs/YYYY-MM-DD.json` — 运行快照（增量对比用）
  - `runs/errors.log` — 错误日志
- `pi-home/` — Pi 运行时主目录（Docker bind mount，含 sessions、auth 等，不纳入版本控制）

## Key Conventions

- All SKILL.md and prompt instructions are written in Simplified Chinese
- browser.js uses "script mode" (JSON step file) for multi-step browser interactions — each invocation is a separate process, so page state cannot persist across calls
- Pipeline 核心逻辑在 `scripts/run-pipeline.js` 中，通过 `scenario.json` + `enrich.js` 实现场景无关化
- Incremental detection: CT.gov 用 NCT ID 集合对比检测新增；CDT 用 `last_cdt_regno` 游标增量搜索，遇到旧数据自动停止翻页
- FDA data is auto-refreshed each run (page updated quarterly by FDA)
- 容器以宿主机用户身份运行（entrypoint.sh 自动检测 UID，通过 gosu 降权）
- 浏览器通过 `BROWSER_ENDPOINT` 环境变量连接远程 browserless（Docker 镜像不含 Chromium）

## Pipeline Integrity (CRITICAL)

- **SKILL.md is the single source of truth** for the business pipeline. When you make ANY improvement that affects data collection, search logic, report generation, or output format, you MUST update the corresponding SKILL.md to reflect the change.
- **Do NOT create standalone scripts that bypass the pipeline.** If a script is needed, it MUST be:
  1. Referenced from the SKILL.md with clear instructions on when/how to run it
  2. Integrated into the Phase flow (e.g., Phase 2 step: "run `node scripts/xxx.js`")
- **Standalone scripts are acceptable ONLY as temporary dev tools.** If you create one, ask yourself: "Will the next run of `/lead-scan` automatically use this?" If not, you MUST update the SKILL.md.
- **Before considering a task complete**, verify that the pipeline (SKILL.md + scripts/run-pipeline.js) produces the correct output end-to-end without manual intervention.
- **Scenario-specific logic** belongs in `scenarios/<name>/scenario.json` (declarative) or `scenarios/<name>/enrich.js` (hooks), NOT in the generic `scripts/lib/` modules.

## Report Output Rules

- **增量模式 (`search_mode: incremental`)**: 报告只输出「新增商机」部分，不包含全量商机列表。全量数据过大，避免每次推送冗余内容。
- **全量模式 (`search_mode: full`)**: 报告同时包含「新增商机」和「全量商机列表」。需要查看完整商机时使用此模式。
- 此行为是项目设计约束，不可擅自修改。如需全量报告，临时设置 `search_mode: full` 后运行即可。
