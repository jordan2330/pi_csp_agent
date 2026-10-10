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
  - `lib/report.js` — 通用**数据模型**（buildLeadModel：窗口切分/证据挂载/分类 + flattenTrials：一行=一条商机，含合并规则与不变量自检）
  - `lib/wecom.js` — 企微 API 客户端（token 缓存 / 智能表格 CRUD / 群机器人推送 / .env 零依赖解析）
  - `lib/wecom-sheet.js` — **智能表格同步器（唯一交付层）**：SCHEMA 38 字段 / 反馈拉取 / upsert（字段级合并，不覆盖销售输入）
  - `wecom-sync.js` — 表格运维 CLI（init 初始化 / status / feedback / checkip 查白名单 IP）
  - `lib/history.js` — 商机沉淀账本（首次发现/最近出现 + 运行批次档案 + 归档行合并）
  - `lib/cde-classify.js` — **法规分类富化（主数据源）**：CDE 官方受理品种信息 → 注册分类 1/2/3/4/5.2类（免费、一手；真实浏览器 DOM 提取）
  - `lib/nmpa-search.js` — 博查搜索富化（**已停用**，二手搜索不参与分类；模块与缓存保留备查）
- `prompts/` — Pi prompt templates (entry points like `/lead-scan`)
- `config/` — Cached data and model configuration
  - `models.json` — LLM 模型配置
  - `api_translations.json` — API 英文名→中文名映射表
  - `search-config.json` — 搜索模式控制（full / incremental）
  - `fda_nitrosamines.json` — FDA 缓存（运行时生成，不纳入版本控制）
- `output/` — 运行快照与账本（derived data）
  - 唯一交付物 = **企微智能表格「CSP商机跟踪」**（由 `scripts/lib/wecom-sheet.js` 同步；docid 在 `config/wecom.json`，gitignore）
  - `history/ledger.json` — **沉淀账本**：每条商机的首次发现/最近出现（不随数据源缓存重置而丢失）
  - `history/feedback.json` — **销售反馈账本**：跟进状态/负责人/备注/日期 事件流（谁/何时/改了什么，从表格拉回）
  - `history/runs.json` — 运行批次档案（时间 / 新增 / 累计 / 数据源计数）
  - `runs/YYYY-MM-DD.json` — 运行快照（增量对比用）
  - `runs/errors.log` — 错误日志
- `~/.pi/` — Pi 运行时主目录（sessions、auth、models.json），在本地家目录，不在仓库内

## Key Conventions

- **版本标记约定**（见 `CHANGELOG.md`）：稳定基线用不可变 tag `<major>.<minor>-stable`；无后缀 tag = 稳定版；实验性大改一律带 `-dev`/`-rc.N` 后缀且不得交付销售
- All SKILL.md and prompt instructions are written in Simplified Chinese
- browser.js uses "script mode" (JSON step file) for multi-step browser interactions — each invocation is a separate process, so page state cannot persist across calls
- Pipeline 核心逻辑在 `scripts/run-pipeline.js` 中，通过 `scenario.json` + `enrich.js` 实现场景无关化
- Incremental detection: CT.gov 用 NCT ID 集合对比检测新增；CDT 用 `last_cdt_regno` 游标增量搜索，遇到旧数据自动停止翻页
- FDA data is auto-refreshed each run (page updated quarterly by FDA)
- 本地运行（WSL Ubuntu 22），不使用容器；仓库根目录即工作目录，脚本路径一律用 `__dirname` 推导或相对路径，禁止硬编码绝对路径
- 浏览器采集依赖 Windows 侧真实 Chrome：由 `scripts/launch-chrome.sh` 启动专用 profile（CDP 端口 9223），WSL 需 mirrored 网络模式（`.wslconfig`: `networkingMode=mirrored`）；`BROWSER_ENDPOINT` 可覆盖默认端点
- 法规分类富化（Phase 2c）主源为 CDE、无需 Key（博查已停用）；如需重启博查需 `BOCHA_API_KEY`（或 `~/.pi/web-search.json` 的 bochaApiKey）；预算与开关见 `config/nmpa-search.json`
- 药物分类优先级：**CDE 官方受理数据 > 博查搜索证据 > 规则推断 > 组内统一**；证据缺失时不改判
- **第三方商业数据源合规红线**：医药魔方 PharmaGO/TrialiCube《用户服务协议》第 2.4 条**明令禁止一切自动化访问**（违反者封号且不退费）→ **禁止**对 pharmcube 系站点写爬虫；只用其人工导出结果做交叉校验，且不长期囤积成自有数据库。CDE/CT.gov 等政府公开数据源无此限制
- CDT 检索必须用**药物名称精确匹配**（`drugs_name` + `drugs_type=2`，二级查询）；禁止用 `keywords` 全文检索——它会把"正文提及"当成"有效成分"（搜他莫昔芬返回阿贝西利片/依西美坦片）
- CDT 已启用瑞数动态安全（Riverdance：JS 质询 + 浏览器指纹检测），必须使用真实浏览器采集；headless/自动化浏览器会被拦截，且不得注入伪造指纹（伪造值本身是可识别特征）

## Pipeline Integrity (CRITICAL)

- **SKILL.md is the single source of truth** for the business pipeline. When you make ANY improvement that affects data collection, search logic, report generation, or output format, you MUST update the corresponding SKILL.md to reflect the change.
- **Do NOT create standalone scripts that bypass the pipeline.** If a script is needed, it MUST be:
  1. Referenced from the SKILL.md with clear instructions on when/how to run it
  2. Integrated into the Phase flow (e.g., Phase 2 step: "run `node scripts/xxx.js`")
- **Standalone scripts are acceptable ONLY as temporary dev tools.** If you create one, ask yourself: "Will the next run of `/lead-scan` automatically use this?" If not, you MUST update the SKILL.md.
- **Before considering a task complete**, verify that the pipeline (SKILL.md + scripts/run-pipeline.js) produces the correct output end-to-end without manual intervention.
- **分类标签与注册分类必须同源推导**：唯一权威 `scripts/lib/nmpa-search.js → labelFromFacts(facts)`（一次产出标签+分类码）。禁止在 enrich.js/wecom-sheet.js 里分别推导（曾出现"仿制药 + 注册2"矛盾）；CDE 证据挂载必须"产品级优先"（`entry.products` 精确命中 > 品种级聚合）
- **智能表格新增/修改列时必须同步四处**（v4.1.2 教训，已三次踩坑）：① `wecom-sheet.js` 列定义 `SCHEMA` ② `rowValues` 行构建 ③ `scalarOf` 比较规则（新字段类型必须加 case，否则每次运行重复 update）④ 不变量自检。漏掉②③会出现「有分类无依据」这类列间矛盾，且同一试验跨 API 的字段会被拼凑成矛盾组合
- **Scenario-specific logic** belongs in `scenarios/<name>/scenario.json` (declarative) or `scenarios/<name>/enrich.js` (hooks), NOT in the generic `scripts/lib/` modules.

## Deliverable Output Rules

- **交付物 = 企微智能表格「CSP商机跟踪」**（v5.0.0 起取代 Excel；`report-xlsx.js` 已删除）。销售收藏同一链接，永远看到最新全量；Markdown 报告早在 v4.1.0 已移除
- **分类只留实锤（v4.2.0 起）**：`药物分类`/`注册分类`/`分类依据` **只来自 CDE 官方受理记录**，未取得证据**留空、不推断**；`分类依据` 只有 `CDE 受理数据（产品级）`/`CDE 受理数据（品种级）` 两个取值。禁止恢复任何规则推断（BE→仿制药、缓释/复方→改良型、期次→新药…），禁止在 `flattenTrials` 里给空值兜底（`|| '未分类'`、`|| '规则推断'`）。已删除列：一致性评价、证据来源；观察性试验的信息放在「分期」列
- **累积视图 + 操作留痕（唯一事实源）**（v4.1.0 起，v5.0.0-rc.2 改表内容口径）：
  - **表 = 窗口内活跃商机 ∪ 有反馈的线索**（销售跟过的不消失）；出窗口且无反馈、及归档行自动移出表（本地账本 `ledger.json` 保留全量；归档行仅有元信息、无联系方式，对销售无价值）——归档审计结论（2026-10-10）：243 条归档行 0% 有联系方式，多为 v3.3.1 校正前的误报残留
  - 本次新增用 **`★本次新增` checkbox** 标识；字段顺序 = 销售阅读顺序（① 判断价值 ② 客户与联系 ③ 方案与依据 ④ 反馈 ⑤ 溯源 ⑥ 系统列最右）；**改 SCHEMA 顺序后需跑 `wecom-sync.js reorder`**（add_fields 前插，重建时倒序）
  - `★ 本次新增` = 相对**上一次运行**的新增**且在时间窗内**；**首次发现** = 历史上第一次见到（沉淀账本，不随重扫重置）——两者不一致是正常的；★ 口径唯一权威在 `wecom-sheet.js`
  - **反馈 4 列**（跟进状态/负责人/跟进备注/跟进日期）**由销售独占写**；数据列由 pipeline 独占写；`update_records` 字段级合并保证互不覆盖（PoC `verify-update` 已验证）；系统 4 列（创建人/时间、最后编辑人/时间）由表格自动维护
  - 销售反馈每次同步拉回，落 `output/history/feedback.json` 事件流；账本均在 `output/history/`（gitignore 内，derived data），落地逻辑见 `scripts/lib/history.js` / `wecom-sheet.js`
- `search_mode`（incremental / full）现在**只控制数据抓取口径**，不再影响交付范围。
- 此行为是项目设计约束，不可擅自改回"增量只出新增"。
- **优先度排序（业务规则）**：口服固体制剂(OSD，含改良释放/颗粒散剂) 优先（`分组`=P1），按 AI limit 风险等级 Cat 1→5 分段（`风险等级`列）；其次为其他剂型（`分组`=P2）同样分段。CSP 推荐方案按**剂型**给出候选组合（依据 CSP 产品选型准则：包装形态优先），风险等级只决定优先级。
