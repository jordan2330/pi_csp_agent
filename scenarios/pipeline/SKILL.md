# 场景：pipeline —— 研发管线 / 管线交易 → CSP 商机

> **当前状态：设计验证阶段（未接数据源、未建表）**。本文件先记录已定案的结论与已验证的事实，避免重复踩坑；实现推进时按 Phase 补全。

## 一句话定位

与 `nitrosamine` 场景的根本差别：那个是「**API 种子列表 → 按药名搜试验 → 申办方**」，这个是「**公司/资产 → 事件流**」。种子轴、行主键、交付列全都不同，**不走 `run-pipeline.js`**。

## 已定案（勿再重复论证）

| 决策 | 结论 |
|---|---|
| 编排 | 新建 `scripts/run-pipeline-events.js`，只复用 `lib/wecom.js`（API 客户端 + `guardWrite`）与 `skills/browser_executor` |
| 交付 | 第二张表「CSP管线商机」，独立同步器（**不复用** 37 列 SCHEMA / `buildLeadModel` / `flattenTrials`）；AGENTS.md 交付口径已改为「唯一交付形态 = 企微智能表格，每场景一张表」 |
| 行粒度 | 一行 = **公司 × 管线资产**，键 `PIPE\|<公司归一名>\|<资产归一名>`；事件进本地 `events.json` 账本，表格只放摘要列 |
| 剂型缺失 | **不丢弃**：D1=0 降权进表，靠事件强度升档；只有「已知注射剂/生物药」（G1）才出局 |
| worktree | 不需要（新目录零冲突；两个 checkout 还会共享同一个 Chrome profile 与 CDT 风控指纹） |

## 业务口径（来自 research/pipeline-business-fit.md，已核对法源）

- 包装决策真实发生地：IND（需描述容器密封系统）→ **III 期/关键临床批是封窗点**（ICH Q1A(R2)：注册稳定性批次必须用拟上市包装）。黄金窗口 = 临床前晚期到 III 期启动前。
- 「研发期企业更愿意尝试贵包装」**无证据**。真实驱动是**稳定性做不出来**（引湿/氧化/亚硝胺/货架期）。对外话术应是「你们加速试验掉含量/结块/出亚硝胺吗」，不是「你们在研发吗」。
- **G1 硬边界**：CSP 无注射剂/生物药方案 → 抗体/ADC/双抗/mRNA/CGT/疫苗一律出局。中国 BD 出海主流恰是这些 → 交易信号必须过 G1。
- 销售预期：本场景是**养线索 + 抢封窗点**，不按转化率考核（按触达率 + 阶段相符度）。

## 队列口径（2026-11-11 与销售确认）

`scenarios/pipeline/scope.js` 是唯一来源：**只要化药 + 注册分类 1/2.x + 申请类型 ∈ {新药, 进口}**。
中药（207 行）与补充申请/进口再注册（449 行）不进池 —— 前者销售确认 CSP 不做，后者是已上市品种的变更（属事件不属新资产）。
公司名归一也在 `scope.js`：机械等价 + `config/company-aliases.json` 人工别名，**不做模糊匹配合并**（错并会让销售反馈互相覆盖）。

## 评分卡（已实现）

`scenarios/pipeline/scoring.js`（纯函数，`node scenarios/pipeline/scoring.js` 跑 6 组自检）

- 维度：D1 剂型 ×2、D2 理化风险 ×2、D3 临期 ×1（lite 满分 15）；D4-D7（企业类型/事件强度/决策权/可联系性）待补，`full` 模式满分 27。
- 阈值：`lite` A≥11 / B≥8 / C≥5；`full` A≥20 / B≥14 / C≥9（与 research 建议一致）。
- 硬闸门：G1 形态不符、G3 原料药 → 出局。

### 已跑通的链路（2026-11-11）

```bash
node scenarios/pipeline/sources-cde.js                  # 增量：按承办日期游标翻页（日常 1 页）
node scenarios/pipeline/sources-cde.js --from 2025-11-11 --start-page 200   # 续回填历史
node scenarios/pipeline/enrich-phase.js                 # 按药品代号挂期次（CT.gov）
```

| 环节 | 实测结果 |
|---|---|
| CDE 受理全量 | 366 页 / 18289 行 → 1834 条公司×资产 → **口径内 1125 行**（化药 + 1/2.x + 新药\|进口） |
| 期次挂载 ①代号 756 个 | 443 命中（59%） |
| 期次挂载 ②英文 INN 280 个 | 38 命中（14%）—— 多数 INN 是已上市药，CT.gov 上只有 PHASE4（按 D3 规则记 0 分，符合预期） |
| 期次覆盖率合计 | **543 / 1125 = 48%**；剩 582 行无期次（其中纯中文名 289 行，需 CDT） |
| 档位（lite） | A **38** / B 333 / C 341 / D 413 |
| D3 分布 | 0 分 712 / I 期 135 / II 期 119 / III 期 159 |

**A 档样例（均人工抽验过 CT.gov 对应试验）**：LNK01001缓释片（凌科药业，III期）、HTD1801胶囊（III期）、TQH3906胶囊（正大天晴，III期）、HRS-7058胶囊（山东盛迪，III期）。

### 三条必须记住的结论

1. **阈值校准（2026-11-11）**：lite 保持 A≥11 / B≥8 / C≥5。理由：A=38 条（销售一周可跟）；升到 12 分只剩 1 条（过严）；降到 10 分会把 300+ 条 B 档提上来。阈值唯一来源是 `scoring.js` 的 `MODES`，改前先看分布。
2. **期次不能用 `query.term` 裸结果取 max**：全文检索会把别人家的 III 期试验带回来。实测 HRS-7058 被错抬到 III 期、ACT001 被 CAR-NK 的“ACT-001”污染 → 必须要求代号出现在**本试验的干预名或标题**里。加了这个校验后 A 档从 34 降到 26（被过滤的 8 条全部是误匹配）。
3. **CT.gov 只索引英文申办方名**：6 家中国企业中文全名实测全部 0 命中（`Jiangsu Nhwa` 8 条、`Hengrui` 697 条可）。→ 按**资产代号**查而不是按企业查；纯中文名资产需走 CDT。
4. **CDE 的 year/applytype 筛选控件不归你管**：设 value + change 不生效（Vue 绑定，总数纹丝不动）→ 只能靠「列表天然按承办日期倒序 + 日期游标」翻页，本地过滤。

### 数据质量问题（已踩）

- `company` 字段有 `不适用`/`无`/`/` 占位值 → 已过滤；多主体行（`A;B`）会拆成多行，同品种可能重复（如恩利西肽片 MSD 两条）→ 待 `company-aliases.json` 归一。
- 注册分类有的带「类」有的不带（`1` vs `1类`、`2.2` vs `2.2类`）→ 已兼容。
- `cde_class_cache.evidence` 是自由文本，656 条里 520 条不是固定 4 段 → **禁止按下标取字段**。

## 数据源（合规已核）

| 源 | 用途 | 状态 |
|---|---|---|
| CDE 受理品种信息（真浏览器，瑞数） | T0 最早信号（IND 承办日期） | ✅ 政府公开，本仓库已有浏览器路径 |
| ClinicalTrials.gov API v2 | 期次/管线反查（`query.lead` + `StudyFirstPostDate` 增窗） | ✅ 但**条款禁止把 email 用于营销**，只用于识别企业 |
| 巨潮 cninfo 正文检索 | BD/授权/首付款事件（T0~T+2） | ⚠️ 条款未明文禁止，但受交易所「商业牟利需许可」约束 → 低频 + 只存派生字段，不囤 PDF |
| **HKEXnews 披露易** | 港股 18A 公告 | ❌ **ToS §5(iii) 禁止程序化/机械方式访问 + 禁建库 + 禁 data mining**。替代：公司 IR 新闻稿（一手）、媒体二手（仅线索）、或书面许可申请 |
| 医药魔方 / 药智 / Insights | 商业库 | ❌ 禁止爬（魔方有官方 MCP 授权通道，需商务） |
| 上交所/深交所 | A 股公告 | ⚠️ 法律声明：商业牟利需书面许可 |

## 评分卡维度现状

| 维度 | 权重 | 数据来源 | 状态 |
|---|---|---|---|
| D1 剂型 | ×2 | 药品名后缀 | ✅ |
| D2 理化风险 | ×2 | 亚硝胺清单/口服肽/浸膏/缓控释/复方 + 引湿类别 | ✅ |
| D3 期次 | ×1 | CT.gov（代号/INN + 干预名校验） | ✅ 48% 覆盖 |
| D4 企业类型与资金 | ×1 | 上市状态 / 融资 —— **无免费源** | ❌（可试 cninfo 证券代码匹配） |
| D5 事件强度 | ×1 | 期次 + 受理号第 4 位（`S`=上市申请 / `L`=临床试验申请） | ✅ |
| D6 决策权 | ×1 | 申请人是否中国主体（中文名+法人后缀） | ✅ 代理指标 |
| D7 可联系性 | ×1 | 官网/IR 页 | ❌ |

full 模式实际上限 21（D4/D7 缺）；阈值 A≥15 / B≥12 / C≥9 → **A 92 / B 284 / C 329 / D 420**。

## 交付层（M4 已落地）

```bash
node scenarios/pipeline/sync.js --init     # 首次建表（幂等，dev 环境自动命名 CSP管线商机-dev）
node scenarios/pipeline/sync.js --dry-run  # 只看会写多少行
node scenarios/pipeline/sync.js            # 同步 A/B 档（默认）
```

- 位置：`scenarios/pipeline/sheet.js`（20 列 SCHEMA + rowValues + scalarOf + 不变量自检 + 反馈拉回）/ `sync.js`（CLI）
- 表选择：`WECOM_TABLE=pipeline` → `config/wecom-pipeline.json`（prod）/ `config/wecom-pipeline.dev.json`（dev），与主表配置互不干扰
- 反馈账本独立：`output/history/feedback-pipeline.json`
- 表内 = 档位 A/B ∪ 有反馈的行；缩表护栏、字段级合并（反馈 4 列销售独占）与主表同款

**企微 API 两个必踩坑（实测）**

1. **数值单元格必须写裸数字**：`{总分: 9}`。写 `[{type:'number',number:9}]` 或 `[{number:9}]` 都会静默丢弃（读回 undefined）。
2. **URL 字段必须带 `property_url`**：`{type:'url', property_url:{type:'LINK_TYPE_ICON_TEXT'}}`，缺了报 `2022019 CheckAddFieldReq failed`；数值字段缺 `property_number` 报 `2022017`。

## 下一步（按顺序）

1. **接通 D3**：CT.gov `query.lead=<企业>` 反查期次 + CDT 按药品名检索期次，把期次覆盖率从 10% 拉起来，再重跑回测校准阈值。
2. CDE 受理「新药（1 类 / 2.x）」全量增量（承办日期游标）→ 公司×资产种子。
3. 建第二张表（≤20 列，含反馈 4 列）+ 独立同步器 + 独立 `config/wecom-pipeline.json`。
4. 二期：cninfo 事件流（叠加 G1、License-out 降权不减分）、公司名归一表 `config/company-aliases.json`。

**本期不做**：港股数据、融资/IPO、LLM 摘要、CSP 推荐矩阵（剂型未知时给了就是假数据）。