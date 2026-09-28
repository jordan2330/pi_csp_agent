---
name: nitrosamine
description: 亚硝胺药物商机发掘场景。从FDA页面抓取亚硝胺杂质风险API列表，在chinadrugtrials和ClinicalTrials.gov双源搜索相关临床试验，匹配客户画像并生成含企业联系方式和CSP产品推荐的商机报告。当需要执行亚硝胺相关的商机发掘时使用此 skill。
---

# 亚硝胺商机发掘场景

## 概述

本场景执行三阶段 pipeline，**通过脚本自动化完成**，agent 仅负责编排和异常处理：

1. **Phase 1**: FDA 数据采集（仅首次运行或缓存过期时，通过浏览器抓取 FDA 页面）
2. **Phase 2**: 双源搜索（CT.gov REST API + CDT 浏览器脚本）→ **Phase 2c 分类富化**（CDE 官方受理数据为主 + 博查兜底）—— **由 `run-pipeline.js` 自动执行**
3. **Phase 3**: 快照生成 + 报告生成 —— **由 `run-pipeline.js` 自动执行**

## 前置条件

- 已加载 `browser-executor` skill
- **Windows 侧真实 Chrome 已启动**（专用 profile，CDP 端口 9223）：`bash scripts/launch-chrome.sh`（已在运行则直接返回）
- WSL 为 mirrored 网络模式（`.wslconfig` → `networkingMode=mirrored`），且 playwright 库已安装（`skills/browser_executor/scripts/` 下 `npm i`）
- `DASHSCOPE_API_KEY` 已配置
- 原因：CDT 已启用瑞数动态安全（JS 质询 + 指纹检测），headless/自动化浏览器会被拦，必须用真实 Chrome

---

## Phase 0: 环境检查与配置读取

### 1. 检查搜索模式

读取 `config/search-config.json`：

```json
{
  "search_mode": "incremental"
}
```

- **`"full"`**（全量模式）：重置所有 API 的搜索状态（CT.gov 缓存与 CDT 游标），重新搜索两个数据源，完成后自动改回 `"incremental"`
- **`"incremental"`**（增量模式，默认）：每次运行仍遍历全部 API，但只增量拉取新增数据——CT.gov 每次全拉并与缓存 NCT ID 对比检测新增；CDT 用 `last_cdt_regno` 游标续搜，遇旧数据自动停止翻页
- **注意**：`search_mode` 只控制**数据抓取口径**，不影响报告范围。Excel 永远是"累积视图"（见 Phase 3）

### 2. 检查 FDA 缓存

检查 `config/fda_nitrosamines.json` 是否存在且非空：
- **存在且 apis 数量 > 0** → 跳到 Phase 1 的快速检查
- **不存在或为空** → 必须执行 Phase 1 完整采集

---

## Phase 1: FDA 数据采集

### 快速检查（缓存有效时）

如果 `config/fda_nitrosamines.json` 已存在：
1. 读取文件，确认 `apis` 中有数据
2. 检查 `fda_page_version` 字段，记录版本号
3. **跳过采集，直接进入 Phase 2**

### 完整采集（仅首次或缓存失效时）

#### FDA 页面 URL

```
https://www.fda.gov/regulatory-information/search-fda-guidance-documents/cder-nitrosamine-impurity-acceptable-intake-limits#predicted
```

#### 操作步骤

1. 创建一个 browser script JSON 文件（如 `/tmp/fda-scrape.json`），内容：

```json
{
  "steps": [
    {
      "action": "navigate",
      "url": "https://www.fda.gov/regulatory-information/search-fda-guidance-documents/cder-nitrosamine-impurity-acceptable-intake-limits#predicted",
      "timeout": 60000
    },
    {
      "action": "wait",
      "selector": "table",
      "timeout": 60000
    },
    {
      "action": "select",
      "selector": "select[name*='_length']",
      "value": "-1"
    },
    {
      "action": "wait",
      "selector": "table tbody tr",
      "timeout": 30000
    },
    {
      "action": "extract",
      "selector": "table",
      "format": "json"
    }
  ]
}
```

2. 执行脚本：
```bash
node skills/browser_executor/scripts/browser.js script /tmp/fda-scrape.json
```

3. 解析输出：FDA Table 1 的每一行包含 4 列：
   - 第1列：Nitrosamine Name（亚硝胺杂质名称）
   - 第2列：Source（对应的 API 名称，可能有多个用分号分隔）
   - 第3列：Potency Category（1-5）
   - 第4列：Recommended AI Limit（如 "100 ng/day"）

4. 去重 Source 列得到唯一 API 列表。对于含多个 API 的行（分号分隔），拆分为单独的 API。

5. 为每个 API 查找中文名：
   - 读取 `config/api_translations.json` 查找表
   - 找到 → 填入 `name_cn`
   - 未找到 → 你（LLM）翻译一次，填入 `name_cn` 并缓存（后续运行不重复翻译）
   - 翻译失败 → `name_cn` 设为 `null`，Phase 2 跳过该API并记录到 errors.log

6. 构建结构化数据并写入 `config/fda_nitrosamines.json`。**使用双源状态机格式**：

```json
{
  "last_updated": "2026-07-11",
  "fda_page_version": "2026-03-19",
  "apis": {
    "Atenolol": {
      "name_cn": "阿替洛尔",
      "ai_limit": "1500 ng/day",
      "potency_category": 4,
      "nitrosamines": ["N-nitroso-atenolol"],
      "fda_detected_at": "2026-07-11",
      "last_cdt_regno": "",
      "lead_count": 0,
      "results": []
    }
  }
}
```

**关键规则：**
- 保留上次运行中已存在的 API 搜索结果和游标
- `last_cdt_regno` 是 CDT 增量游标（最大 regNo），空字符串表示未搜索
- CT.gov 无游标，每次全量拉取后与缓存对比检测新增

#### 错误处理

- 如果 FDA 页面无法访问，重试 3 次
- 仍失败则使用 `config/fda_nitrosamines.json` 中的缓存数据，并在报告中注明使用了缓存

---

## Phase 2 + 3: 搜索 + 报告生成（由脚本自动完成）

**这是核心执行步骤。** FDA 数据就绪后，调用 pipeline 脚本。

### 执行方式（重要：CDT 搜索可能耗时 1.5-2 小时）

由于 CDT 浏览器搜索较慢，必须使用**后台执行 + 轮询**模式：

```bash
# 1. 后台启动 pipeline
nohup node scripts/run-pipeline.js nitrosamine > output/runs/pipeline.log 2>&1 &
echo "Pipeline PID: $!"
```

然后每隔 2 分钟检查进度：
```bash
# 检查是否还在运行
kill -0 <PID> 2>/dev/null && echo "运行中" || echo "已完成"

# 查看最新日志
tail -5 output/runs/pipeline.log
```

当 pipeline 完成后（进程不存在），检查输出：
```bash
tail -20 output/runs/pipeline.log
```

**注意**：如果 CT.gov 和 CDT 都已经搜索完成（增量模式下待搜索为 0），pipeline 会在 1 秒内完成，无需后台执行。可以先同步尝试，超时后再转后台。

### 脚本自动完成的流程

#### Phase 2a: CT.gov REST API 搜索
- 使用 `https://clinicaltrials.gov/api/v2/studies` REST API（不是浏览器）
- 每个 API 用英文名搜索，限定 `locStr=China`
- 提取：产品名称（Intervention.name）、剂型（Intervention.description 推断）、联系方式（centralContacts + Location.contacts）
- 日期过滤：仅保留窗口期内的试验（窗口 = `scenario.json → lookback_years`，当前 **1 年**；CT.gov 用精确日期，CDT 用登记号年份粒度）
- 每个 API 间隔 800ms，约 5-8 分钟完成全部 251 个 API（单次失败自动重试：超时/429/5xx 最多 3 次尝试，递增退避）

#### Phase 2b: CDT 浏览器搜索（本机真实 Chrome + 单 worker）
- 通过 CDP 连接 Windows 侧真实 Chrome（端点由 `browser-connect.js` 解析；真浏览器模式不覆盖 UA/viewport，也不注入伪造指纹）
- **单 worker**（`run-pipeline.js` 中 `CDT_WORKER_COUNT = 1`）：CDT 已启用瑞数反爬，低频单线程行为更像真人
- 每个 API 创建独立 context+page，用完关闭；页面级断连自动重建 session 重试
- 调用 `scripts/lib/sources.cdtSearchOneAPI()` → `skills/browser_executor/scripts/cdt-search-lib.js`
- **检索方式：药物名称精确匹配（二级查询）**——`?drugs_name=<API中文名>&drugs_type=2`
  - ⚠️ 不可用旧的 `?keywords=`（全文关键词检索）：正文里提到某 API 就会被命中，
    例如搜"他莫昔芬"会返回"阿贝西利片/依西美坦片"（正文只写了"联合内分泌治疗（他莫昔芬或芳香化酶抑制剂）"），产生大量错误数据
  - 实测：他莫昔芬 21 条(误报为主) → **2 条**(均为枸橼酸他莫昔芬片)；二甲双胍 825 → 577 条
  - 结果仍按登记号降序 → 增量游标与年份早停逻辑不受影响
  - 调试可用 `CDT_SEARCH_MODE=keyword` 回到旧行为对比
- 提取：产品名称（drugName）、剂型（中文后缀识别）、试验分期、企业联系方式
- 每 API 参数：`maxPages: 5, batchSize: 50`
- 时间窗过滤：登记号年份 >= 窗口起始年（`lookback_years`）；结果按登记号降序，**整页登记号都早于窗口年份即早停翻页**（省请求、降风控暴露）
- API 间延迟: 5-8s（配置在 `config/cdt-throttle.json`）
- 全量（首次/重扫）约 3-4 小时；增量模式无新增时每 API 仅翻 1-2 页，通常几十分钟完成
- 如确需提速可临时把 `CDT_WORKER_COUNT` 调到 2（代价：并发行为更容易被风控识别）

#### Phase 2c: 法规分类富化（注册分类 / 一致性评价）—— 双数据源
**2c-1（主）：CDE 官方受理品种信息**（`scripts/lib/cde-classify.js`，v4 新增）
- **为什么**：临床试验登记数据里没有注册分类（1类创新/2类改良/3-4类仿制）。博查是"搜索引擎二手信息猜"（命中率约 31%），CDE 受理品种信息是**官方一手申报数据**，直接给出 `受理号 | 药品名称 | 药品类型 | 申请类型 | 注册分类 | 企业名称 | 承办日期`
- 数据来源（政府信息公开页，与 CDT 同性质、无自动化禁止条款，免费无查询成本）：
  `https://www.cde.org.cn/main/xxgk/listpage/9f9c74c73e0f8f56a8bfbc646055026d`
- **注册分类口径（权威依据，v4.1.3 修正；按药品类型区分！）**
  | 药品类型 | 分类码 | 含义 | → 药物分类 |
  |---|---|---|---|
  | 化药（2020年第44号） | 1 | 境内外均未上市创新药 | 新药 |
  | | 2.1 / 2.2 / 2.3 / 2.4 | 改良型新药（光学异构体·成盐成酯 ／ 新剂型新给药途径 ／ **新复方制剂** ／ 新适应症） | 新药（改良型） |
  | | 3 | 境内仿制"境外上市但境内未上市"原研 | 仿制药 |
  | | 4 | 境内仿制"已在境内上市"原研 | 仿制药 |
  | | 5.1 | 境外上市**原研**申请境内上市 | 原研药 |
  | | 5.2 | 境外上市**非原研（仿制）**申请境内上市 | 仿制药 |
  | 生物制品（2020年第43号） | 1 / 2 | 创新型 ／ 改良型 | 新药 ／ 新药（改良型） |
  | | 3.1 / 3.2 / 3.4 | 进口或境内生产的已上市生物制品 | 原研药 |
  | | **3.3** | 生物类似药 | **仿制药** |
  | 中药（2020年第68号） | 1 / 2 | 中药创新药 ／ 中药改良型新药 | 新药 ／ 新药（改良型） |
  | | 3 | 古代经典名方中药复方制剂（**不是仿制**） | 新药 |
  | | 4 | 同名同方药 | 仿制药 |
  | 旧分类（2020-07-01 前受理，平台显示"原X"） | 原1/原3/原5 | 旧新药 | 新药 |
  | | 原2/原4 | 旧新药（改给药途径/改剂型） | 新药（改良型） |
  | | **原6** | 旧仿制药 | 仿制药 |
  - 申请类型含"仿制"但分类空 → 仿制信号；含"一致性评价" → 过评信号（只填"一致性评价"列，不改变分类标签）
- **产品级证据优先（v4.1.3 关键修正）**：CDE 按"药品名称"**子串**检索，一条缓存条目可能含多个产品
  （查"沙丁胺醇"同时返回「硫酸沙丁胺醇片 4类仿制」和「盐酸左沙丁胺醇异丙托溴铵吸入溶液 **2.1类新药**」）。
  采集时按药品名称聚合出 `entry.products`（产品级 facts），挂证据时**先用试验产品名精确/包含匹配**，
  命中则用产品级证据（`level='product'`）；否则回落品种级聚合。**品种级聚合会把改良型新药误判成仿制药**，务必保留此顺序。
- **标签与注册分类同源推导**：`nmpa-search.labelFromFacts(facts)` 是唯一权威，一次产出（标签, 注册分类码），
  优先级 仿制 > 改良 > 创新 > 进口原研。**禁止**在别处分别推导标签与注册分类（曾产出"仿制药 + 注册2"这种自相矛盾）
- **标签出处与"过评"事实分离**：博查的品种级"过评"信号（iec）只填「一致性评价」列，**不参与分类标签推导**；
  证据来源列按实际采用来源标注（如 `博查搜索(sohu.com) · CDE 无分类信号`）
- 检索：**药品名称子串匹配**（查"氨氯地平"→ 比索洛尔氨氯地平片/阿齐沙坦氨氯地平片…）；目标集 = **只查有试验的品种**（API 中文名 + 试验里出现的真实产品名），无试验的 FDA 品种不查（多为中国未上市，CDE 无记录）
- 实测性能：**1.5-3 秒/品种**，每页 50 条、最多翻 2 页，无反爬质询；177 个品种约 10 分钟
- 三条关键健壮性设计（踩坑后加的，勿删）：
  1. **定位可见表单**：页面有 22 个"查询"按钮（多个隐藏标签页），必须找 `offsetParent !== null` 的输入框 + **同一 form 内**的查询按钮，否则点了别的表单 → 搜索没生效
  2. **默认列表指纹识别**：站点渲染延迟约 1.5s 且无 loading 指示。若结果与"未筛选的默认列表"首行完全相同 → 判定查询未生效 → 重试（否则会把默认列表当成该品种数据）
  3. **可信空结果**：点击 2.5s 后仍显示"暂无内容" → 才算真无记录；失败（未生效）**不写 `queried_at`** → 下次运行自动重试，不会被 90 天 TTL 锁死
- 缓存 `config/cde_class_cache.json`（含 `rules_version`）；配置 `config/cde-classify.json`（`enabled` / `cache_ttl_days` / `max_pages_per_product` / `page_size` / `max_products_per_run` / `delay_between_products_ms`）
- CLI：`node scripts/lib/cde-classify.js [--max N] [--product 名称] [--stats]`

**2c-2（已停用 v4.2.0）：博查搜索富化**（`scripts/lib/nmpa-search.js`；二手搜索不参与分类，`enabled=false`，模块保留备查）
- 已被 CDE 覆盖（有分类信号）的品种**不再花博查额度**（`run-pipeline.js` 自动跳过）
- 两级查询：Web Search（便宜，默认）→ AI Search 兜底（`config/nmpa-search.json → ai_search_escalation`，实测收益低，可关）
- **品种名门控**：结果标题/摘要必须含品种核心名（去盐基/剂型后缀），否则会拿到近似品种的证据（查"富马酸贝达喹啉片"会返回"富马酸卢帕他定片"）
- **归属判定**：API 级证据只在"试验药物就是该品种"时套用（否则亚叶酸钙出现在双抗化疗方案里会被误判为仿制）
- 证据缺失时不改判（回落规则推断），只补信息
- 缓存 `config/nmpa_class_cache.json`（含 `rules_version`，规则升级即失效重查）；单次预算 `max_queries_per_run`（默认 100 次），超出跳过并记 errors.log
- 输出四列进 Excel：**分类依据 / 注册分类 / 一致性评价 / 证据来源**；概览有"法规分类证据（Phase 2c）"+"药物分类依据"统计段
  - `分类依据` 四值语义：**官方证据(CDE)**（标签与 CDE 官方受理数据一致，可查证）/ **搜索证据**（与博查证据一致）/ **规则（证据不适用）**（该品种有证据，但按原研企业/代码号排除）/ **规则推断**（无可用证据）
  - `证据来源` 列：CDE → `CDE 官方`；博查 → 证据域名（如 nbd.com.cn）；**证据存在但未采用**时加后缀 `（未采用）`（避免"规则（证据不适用）‖ CDE 官方"读起来自相矛盾）
  - **列必须成套取**（`report-xlsx.js` flattenTrials）：药物分类 / 分类依据 / 注册分类 / 一致性评价 / 证据来源 是一组，同一试验命中多个 API 时按证据强度（官方证据 > 搜索证据 > 规则（证据不适用）> 规则推断）挑**一条子行整体搬运**；**禁止逐列独立取**（会出现"分类依据=规则推断 + 证据来源=CDE 官方"这类矛盾组合）
  - **不变量自检**：`flattenTrials` 每次生成都校验列间一致性（规则推断不得有证据来源、官方证据来源必须是 CDE…），有矛盾即 stderr 报警并在 pipeline 日志显示"列一致性自检: N 处矛盾"；新增列**必须同步更新合并规则与自检**
  - 优先级要点：**仿制证据 > 名称启发式**——缓释/复方既可能是 2 类改良型，也可能是原研缓释/复方产品的 4 类仿制（如盐酸他喷他多缓释片），名称本身分不出来

#### Phase 3: 快照 + 沉淀账本 + Excel（累积视图 · 只留实锤）
- **增量检测：对比前次快照标记 isNew；同日二次运行对比当天已有快照,避免重复汇报新增**
- 从 `config/fda_nitrosamines.json` 生成快照到 `output/runs/YYYY-MM-DD.json`
- **沉淀账本（`scripts/lib/history.js`）**：`output/history/ledger.json`（每条商机 first_seen/last_seen，重扫不重置）+ `runs.json`（批次档案，由渲染器写入以保证 ★ 口径单一权威）；缓存里消失的历史行以 `archived:true` 并入快照
- **交付物只有 `output/CSP_Leads_Report.xlsx`**（Markdown 已移除），6 个 sheet：
  | Sheet | 内容 |
  |---|---|
  | 概览 | 本批次信息 + 图例（★/首次发现/窗口状态）+ 分类证据覆盖 + 数据局限 |
  | P1-口服固体 / P2-其他剂型 | **仅窗口内**活跃商机，按 Cat 1→5 分段；★ 行浅绿底 |
  | 全部商机 | **累积全量**（含已过窗口/已归档）|
  | 按API汇总 | 一行 = 一个 API（试验数/本次新增/历史行数/企业数/OSD 数/推荐方案）|
  | 批次历史 | 一行 = 一次运行（★新增/抓取新增/累计/窗口内活跃）+ 账本按首次发现批次累计 |

- **分类语义（v4.2.0 收紧：只留实锤，不做推断）**
  - `药物分类` / `注册分类` / `分类依据` **只来自 CDE 官方受理记录**；**未取得证据一律留空，不做任何推断**（宁可留空让销售人工核对）
  - `分类依据` 取值只有两个：`CDE 受理数据（产品级）`（试验产品精确命中某条受理记录，最可靠）/ `CDE 受理数据（品种级）`（仅查到该品种，非该产品）；无证据 → 空
  - **已删除的列**：`一致性评价`、`证据来源`（前者依赖二手搜索、后者与依据列重复）
  - **已删除的推断规则**（勿恢复）：BE/生物等效→仿制药、缓释/复方名称→改良型、期次→新药/原研药、IV期→仿制药、产品级规则统一、组内多数票、"未分类"兜底
  - `观察性研究` 不再占用药物分类列 → 移到 **`分期` 列**显示为 `观察性（非干预）`（注册平台事实字段）
  - 例外（品种级证据不套用，保持留空）：**原研企业申办**、**代码号在研新药**（如 TQC3927）
  - 博查搜索富化**已停用**（`config/nmpa-search.json → enabled=false`）：二手搜索不参与分类；模块与缓存保留备查
  - 教训：**空值必须显式留空**——`flattenTrials` 里任何 `|| '未分类'`、`|| '规则推断'` 式兜底都会把"无证据"伪装成结论（v4.2.0 已清除）

### 双源搜索状态跟踪

增量搜索机制：

- **CT.gov**: 每次运行都拉取全部结果（~5分钟/251API），通过对比缓存中的 NCT ID 检测新增试验
- **CDT**: 每个 API 记录 `last_cdt_regno` 游标（最大 regNo），增量搜索时只获取游标之后的新数据，遇到旧数据自动停止翻页
- `search_mode: "full"` 重置所有游标并全量重搜，完成后自动切回 `incremental`

两个来源完全独立。CDT 的增量效率极高——无新增时只需翻 1-2 页即停。
