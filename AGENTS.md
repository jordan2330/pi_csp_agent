# AGENTS.md

## Project Overview

This is a Pi Coding Agent project for CSP (Aptar active packaging) sales lead discovery. The agent scrapes regulatory and clinical trial data, matches customer profiles, and generates Markdown lead reports.

## LLM Configuration

- Provider: Aliyun DashScope (百炼) via OpenAI-compatible API
- Endpoint: `https://dashscope.aliyuncs.com/compatible-mode/v1`
- Models: `qwen3.7-max` / `deepseek-v4-pro` / `glm-5.2` / `kimi-k2.6` for complex reasoning, `qwen3.7-plus` / `deepseek-v4-flash` for routine tasks
- Config: 仓库内 `config/models.json` 是版本控制中的源，本地运行时复制到 `~/.pi/agent/models.json`（WSL: `/home/<user>/.pi/agent/models.json`）
- API key: `DASHSCOPE_API_KEY` environment variable
- All models use `thinkingFormat: "qwen"` (Aliyun unified endpoint)

## Project Structure

- `skills/browser_executor/` — Generic Playwright browser automation tool (shared across all scenarios)
  - `scripts/browser.js` — Playwright 封装（navigate/type/click/wait/select/evaluate/delay/loop/extract/screenshot）
  - `scripts/browser-connect.js` — 连接解析：真浏览器 CDP 优先，默认端点不可用时自动拉起 Chrome
  - `scripts/cdt-search-lib.js` — CDT 搜索核心逻辑（增量游标 + 详情页提取，pipeline 直接 require）
  - `scripts/cdt-search.js` — 同上的 CLI 包装（调试/验证用）
- `scenarios/` — Business scenario skills (nitrosamine, probiotics, IVD, etc.)
  - `scenarios/<name>/SKILL.md` — 场景指令（pipeline 编排）
  - `scenarios/<name>/scenario.json` — 声明式配置（表头列、CSP推荐矩阵、数据时间窗、缓存/报告路径）
  - `scenarios/<name>/enrich.js` — 场景专属 hooks（药物分类、CSP推荐、报告小标题等）
- `scripts/` — Pipeline 自动化脚本
  - `run-pipeline.js` — 主编排器（Phase 2+3：双源搜索 → 快照 → 报告）
  - `launch-chrome.sh` — 启动 Windows 侧专用 profile Chrome 并开放 CDP 端点（本地运行必需）
  - `reset-and-search.sh` — 从零全量重置脚本
  - `lib/sources.js` — 数据源统一接口（CT.gov REST API + CDT 浏览器脚本）
  - `lib/enrichment.js` — 剂型检测（中英文，词干匹配兼容复数/派生词）、产品名提取、剂型分组
  - `lib/snapshot.js` — 快照管理 + 增量检测
  - `lib/report.js` — 通用 Markdown 报告渲染器（由 scenario.json + enrich.js 驱动）
  - `lib/report-xlsx.js` — 通用 Excel 渲染器（5 sheet：概览 / P1-口服固体 / P2-其他剂型 / 全部商机 / 按API汇总）
  - `lib/nmpa-search.js` — 法规分类富化：博查搜索抽取 NMPA 注册分类/一致性评价证据（品种名门控 + 归属判定 + 缓存/预算）
- `prompts/` — Pi prompt templates (entry points like `/lead-scan`)
- `config/` — Cached data and model configuration
  - `models.json` — LLM 模型配置
  - `api_translations.json` — API 英文名→中文名映射表
  - `search-config.json` — 搜索模式控制（full / incremental）
  - `fda_nitrosamines.json` — FDA 缓存（运行时生成，不纳入版本控制）
- `output/` — Generated reports and run snapshots
  - `CSP_Leads_Report.xlsx` — **主交付物**（销售用 Excel：OSD 优先分组 + 自动筛选 + 可透视）
  - `CSP_Leads_Report.md` — Markdown 报告（文本存档 / pi 摘要）
  - `runs/YYYY-MM-DD.json` — 运行快照（增量对比用）
  - `runs/errors.log` — 错误日志
- `~/.pi/` — Pi 运行时主目录（sessions、auth、models.json），在本地家目录，不在仓库内

## Key Conventions

- All SKILL.md and prompt instructions are written in Simplified Chinese
- browser.js uses "script mode" (JSON step file) for multi-step browser interactions — each invocation is a separate process, so page state cannot persist across calls
- Pipeline 核心逻辑在 `scripts/run-pipeline.js` 中，通过 `scenario.json` + `enrich.js` 实现场景无关化
- Incremental detection: CT.gov 用 NCT ID 集合对比检测新增；CDT 用 `last_cdt_regno` 游标增量搜索，遇到旧数据自动停止翻页
- FDA data is auto-refreshed each run (page updated quarterly by FDA)
- 本地运行（WSL Ubuntu 22），不使用容器；仓库根目录即工作目录，脚本路径一律用 `__dirname` 推导或相对路径，禁止硬编码绝对路径
- 浏览器采集依赖 Windows 侧真实 Chrome：由 `scripts/launch-chrome.sh` 启动专用 profile（CDP 端口 9223），WSL 需 mirrored 网络模式（`.wslconfig`: `networkingMode=mirrored`）；`BROWSER_ENDPOINT` 可覆盖默认端点
- 法规分类富化（Phase 2c）需 `BOCHA_API_KEY`（或 `~/.pi/web-search.json` 的 bochaApiKey）；预算与开关见 `config/nmpa-search.json`
- 药物分类优先级：**搜索证据（NMPA 注册分类/一致性评价）> 规则推断 > 组内统一**；证据缺失时不改判
- CDT 检索必须用**药物名称精确匹配**（`drugs_name` + `drugs_type=2`，二级查询）；禁止用 `keywords` 全文检索——它会把"正文提及"当成"有效成分"（搜他莫昔芬返回阿贝西利片/依西美坦片）
- CDT 已启用瑞数动态安全（Riverdance：JS 质询 + 浏览器指纹检测），必须使用真实浏览器采集；headless/自动化浏览器会被拦截，且不得注入伪造指纹（伪造值本身是可识别特征）

## Pipeline Integrity (CRITICAL)

- **SKILL.md is the single source of truth** for the business pipeline. When you make ANY improvement that affects data collection, search logic, report generation, or output format, you MUST update the corresponding SKILL.md to reflect the change.
- **Do NOT create standalone scripts that bypass the pipeline.** If a script is needed, it MUST be:
  1. Referenced from the SKILL.md with clear instructions on when/how to run it
  2. Integrated into the Phase flow (e.g., Phase 2 step: "run `node scripts/xxx.js`")
- **Standalone scripts are acceptable ONLY as temporary dev tools.** If you create one, ask yourself: "Will the next run of `/lead-scan` automatically use this?" If not, you MUST update the SKILL.md.
- **Before considering a task complete**, verify that the pipeline (SKILL.md + scripts/run-pipeline.js) produces the correct output end-to-end without manual intervention.
- **Scenario-specific logic** belongs in `scenarios/<name>/scenario.json` (declarative) or `scenarios/<name>/enrich.js` (hooks), NOT in the generic `scripts/lib/` modules.

## Report Output Rules

- **增量模式 (`search_mode: incremental`)**: 报告只输出「新增商机」部分，不包含全量商机列表。全量数据过大，避免每次推送冗余内容。**两种交付物（xlsx / md）均遵守此规则**（Excel sheet 名前缀 `新增-`）。
- **全量模式 (`search_mode: full`)**: 报告同时包含「新增商机」和「全量商机列表」。需要查看完整商机时使用此模式。
- 此行为是项目设计约束，不可擅自修改。如需全量报告，临时设置 `search_mode: full` 后运行即可。
- **Excel 优先度排序（业务规则）**：口服固体制剂(OSD，含改良释放/颗粒散剂) 优先，按 AI limit 风险等级 Cat 1→5 分段；其次为其他剂型同样分段。CSP 推荐方案按**剂型**给出候选组合（依据 CSP 产品选型准则：包装形态优先），风险等级只决定优先级。
