---
name: nitrosamine
description: 亚硝胺药物商机发掘场景。从FDA页面抓取亚硝胺杂质风险API列表，在chinadrugtrials和ClinicalTrials.gov双源搜索相关临床试验，匹配客户画像并生成含企业联系方式和CSP产品推荐的商机报告。当需要执行亚硝胺相关的商机发掘时使用此 skill。
---

# 亚硝胺商机发掘场景

## 概述

本场景执行三阶段 pipeline：
1. 从 FDA 页面抓取亚硝胺杂质和对应 API 列表（含中英文名称）
2. **双源搜索**：对每个 API 分别在 chinadrugtrials.org.cn（主源，用中文名搜索）和 ClinicalTrials.gov（辅源，用英文名+China限定）搜索临床试验。两个来源独立跟踪搜索状态，每个 API 必须在两个网站都搜索过才算完成
3. 生成包含 CSP 产品推荐、**企业联系方式**、**产品名称**和**药物分类**的 Markdown 商机报告

## 前置条件

- 已加载 `browser-executor` skill
- Docker 容器已启动，`BROWSER_ENDPOINT` 已配置（指向独立 browserless）
- `DASHSCOPE_API_KEY` 已配置

---

## Phase 0: 搜索模式检查（新增）

### 全量重置 vs 增量搜索

在开始搜索前，读取 `config/search-config.json`：

```json
{
  "search_mode": "incremental"
}
```

- **`search_mode: "full"`**（全量模式）：
  - 将所有 API 的 `searched_cdt` 和 `searched_ctgov` 重置为 `false`
  - 清空所有 `previous_trial_data`
  - 然后按正常流程执行搜索
  - **搜索完成后自动将 `search_mode` 改回 `"incremental"`**
  - 适用场景：首次上线部署、需要完整数据刷新时

- **`search_mode: "incremental"`**（增量模式，默认）：
  - 正常的断点续传逻辑（见下文）
  - 适用场景：日常定期运行

用户手动触发全量搜索的方法：
1. 编辑 `config/search-config.json`，将 `search_mode` 改为 `"full"`
2. 执行 `/lead-scan nitrosamine`

---

## Phase 1: FDA 数据采集

### 目标

从 FDA 页面解析 Table 1，提取所有亚硝胺杂质记录及其对应的 API（含中英文名称）。

### FDA 页面 URL

```
https://www.fda.gov/regulatory-information/search-fda-guidance-documents/cder-nitrosamine-impurity-acceptable-intake-limits#predicted
```

### 操作步骤

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

**重要**：`select` 步骤用于选择页面分页为"All"，确保所有行都渲染到DOM中。`select[name*='_length']` 是 DataTables 页码选择器的推测值，你需要先截图分析实际HTML结构再调整。`value: "-1"` 对应 "All" 选项。

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

6. 构建结构化数据并写入 `config/fda_nitrosamines.json`。**使用双源状态机格式**（每个 API × 每个数据源独立跟踪搜索状态）：

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
      "searched_cdt": false,
      "searched_cdt_date": null,
      "searched_ctgov": false,
      "searched_ctgov_date": null,
      "lead_count": 0,
      "previous_trial_data": []
    }
  }
}
```

**关键规则：**
- **保留上次运行中已存在的 API 搜索状态**
- `searched_cdt` 和 `searched_ctgov` 是两个独立的布尔标记，分别跟踪 chinadrugtrials 和 ClinicalTrials.gov 的搜索完成状态
- 只有当 `searched_cdt: true` **且** `searched_ctgov: true` 时，该 API 才视为已完成搜索
- 如果只有一个源搜索过，仍然需要对未搜索的源执行搜索
- 兼容旧格式：如果遇到 `china_trial_searched` 字段（旧版），将其视为 `searched_cdt = searched_ctgov = china_trial_searched`，并在更新时替换为新格式

### 错误处理

- 如果 FDA 页面无法访问，重试 3 次
- 仍失败则使用 `config/fda_nitrosamines.json` 中的缓存数据，并在报告中注明使用了缓存

---

## Phase 2: 中国临床试验搜索（双源）

### 目标

对每个**未完成的** API，在**两个数据源**分别搜索相关临床试验：
- **主源 chinadrugtrials.org.cn**：用 API 中文名搜索（中国本土数据，含企业联系方式）
- **辅源 ClinicalTrials.gov**：用 API 英文名 + China 限定（补充国际企业在中国的临床）

### 双源断点续传机制

读取 `config/fda_nitrosamines.json`，对每个 API 独立判断两个数据源：

```
对于每个 API:
  if searched_cdt == false:
    → 在 chinadrugtrials 搜索
    → 搜索完成后立即设 searched_cdt = true, searched_cdt_date = 当天
  
  if searched_ctgov == false:
    → 在 ClinicalTrials.gov 搜索
    → 搜索完成后立即设 searched_ctgov = true, searched_ctgov_date = 当天
  
  if searched_cdt == true && searched_ctgov == true:
    → 该 API 搜索完成，跳过
```

**关键：两个来源完全独立跟踪**。一个来源失败不影响另一个来源的状态更新。每完成一个源的搜索就立即写入文件。

### 搜索策略

对每个未完成搜索的 API × 数据源组合：

1. **chinadrugtrials 搜索**（如 `searched_cdt == false`）：
   - 用 `name_cn`（中文名）搜索
   - 即使该 API 在 ClinicalTrials.gov 已有结果，也必须搜索 CDT（因为 CDT 有中国企业联系方式和产品名称）
   - CDT 搜索失败（超时/验证码）→ 标记 `searched_cdt = true` 但记录错误，不重试

2. **ClinicalTrials.gov 搜索**（如 `searched_ctgov == false`）：
   - 用英文名 + `locStr=China` 限定中国地区
   - 即使 CDT 已有结果，也必须搜索 CT.gov（补充国际药企在中国的临床）
   - CT.gov 搜索失败 → 标记 `searched_ctgov = true` 但记录错误

3. 两个来源都无结果的 API：`lead_count = 0`，不在报告中列出

**不再有"回退"逻辑**：两个来源都搜索，互不替代。

### chinadrugtrials 搜索流程（主源）

搜索页面 URL：`https://www.chinadrugtrials.org.cn/clinicaltrials.searchlist.dhtml`

#### 推荐方式：使用 cdt-search.js 脚本

`skills/browser_executor/scripts/cdt-search.js` 是专用搜索脚本，自动完成搜索、翻页和详情页提取：

```bash
node skills/browser_executor/scripts/cdt-search.js "API中文名" /tmp/cdt-result.json [--max-details 30] [--max-pages 10]
```

- `--max-details N`：最多获取 N 条详情页（默认30，设0=全部）。详情页含申请人名称和联系方式，但每条需单独加载，大量结果时会很慢
- `--max-pages N`：最多翻 N 页（默认10，每页20条）
- 输出 JSON 格式，包含每条试验的完整字段

#### 页面结构说明（2026-07-12 实测验证）

**搜索结果页** (`searchlist.dhtml`)：
- **搜索方式**：直接 URL 参数 `?keywords=关键词`，**不要**用表单 `type` + `click` 交互。URL参数最可靠，页面直接返回过滤后的结果
- **结果表格**：`table.searchTable`，列为：序号 / 登记号 / 试验状态 / 药物名称 / 适应症 / 试验通俗题目
- **分页信息**：`div.pageInfo` 内含「当前第 X 页，共 Y 页，共 Z 条记录」
- **翻页方式**：JS 函数 `gotopage(N)`，通过 `evaluate` action 调用。**不是** `ul.pagination` + `<li>` 结构
- **每页行数**：固定20条

**详情页** (`searchlistdetail.dhtml?reg_no=XXX`)：
- **Table 0**：登记号、试验状态、申请人联系人、首次公示信息日期、申请人名称
- **Table 1**：药物名称、药物类型、适应症、试验题目（科学/通俗）、方案编号
- **Table 2**：申请人名称、联系人姓名/电话/Email/地址
- **Table 3**：试验分类、试验分期、设计类型、试验范围
- **Table 13**：主要研究者（姓名、学位、职称、电话、Email、单位）
- **Table 14**：试验机构列表（机构名称、主要研究者、省、城市）
- **Table 15**：伦理审批（委员会名称、审查结论、批准日期）
- **Table 16**：目标入组人数、已入组人数
- **Table 17**：第一例知情同意日期、第一例入组日期、试验完成日期

**重要提示**：
- 页面是服务端渲染（SSR），数据直接在 HTML 中，无需等待 JS 加载
- `#goSearch` 是 `<div>` 元素（非 button），用 `click` action 可触发，但不如直接 URL 参数可靠
- 搜索结果表格里 `<a onclick="getDetail(this.id)">` 的 id 属性可用于构造详情页 URL
- 该站**无** JS challenge / 反爬保护，之前报告的 HTTP 202 是误判（可能是 browserless 连接复用问题）

#### 提取字段

对每条搜索结果，提取以下字段（**含联系方式，供市场部直接触达**）：

**基础信息：**
- **申请人名称**（来自详情页 Table 0）
- **药物名称**（Table 1，即产品名称，如"盐酸度洛西汀肠溶胶囊"）
- **药物类型**（Table 1，如"化学药品"、"生物制品"等）
- 登记号（CTR编号）
- 试验状态（进行中/已完成/尚未招募/主动终止）
- 适应症
- 试验通俗题目 / 科学题目
- 试验分期（I期/II期/III期/IV期/其它-BE）
- 首次公示信息日期
- 伦理审批日期

**企业联系信息（来自 Table 2，市场部核心数据）：**
- **联系人姓名**
- **联系电话**
- **联系邮箱**
- **联系地址**

**主要研究者信息（来自 Table 13）：**
- PI 姓名、学位、职称
- PI 电话、邮箱
- PI 所在单位

**试验机构列表（来自 Table 14）：**
- 机构名称、PI、省、城市

**药物分类判断（你 LLM 基于以下规则推断）：**

| 判断依据 | 分类结果 | 说明 |
|---------|---------|------|
| 试验分期 = "其他-BE" 或 designType 含"生物等效" | **仿制药** | BE 试验 = 仿制药一致性评价 |
| 试验分期 = I期 且药物名称为新剂型/新规格 | **新药（改良型）** | 505(b)(2) 类改良新药 |
| 申请人为跨国药企原研方（如 Bayer、Novartis、Sanofi 等）且 III/IV 期 | **原研药** | 原研企业在中国的临床试验 |
| 试验分期 = I期 且申请人为创新药企 | **新药** | 全新化合物 |
| 无法判断 | **（留空）** | 不猜测，宁可留空 |

**注意**：药物分类字段 `drug_classification` 取值为 `"仿制药"` / `"原研药"` / `"新药"` / `"新药（改良型）"` / `null`。

### ClinicalTrials.gov 搜索流程（辅源）

无论 chinadrugtrials 是否有结果，都需要搜索 ClinicalTrials.gov（补充国际药企数据）。

搜索 URL：`https://clinicaltrials.gov/search?term=API英文名&locStr=China`
ClinicalTrials.gov 是美国政府网站，反爬较弱。

创建 browser script JSON（如 `/tmp/trial-search-fallback.json`）：

```json
{
  "steps": [
    {
      "action": "navigate",
      "url": "https://clinicaltrials.gov/search?term=API_NAME_EN&locStr=China",
      "timeout": 60000
    },
    {
      "action": "wait",
      "selector": "#study-list",
      "timeout": 30000
    },
    {
      "action": "extract",
      "selector": "#study-list",
      "format": "json"
    },
    {
      "action": "loop",
      "exit_when": { "selector": ".pagination .next.disabled, button[data-loading-state]:disabled", "condition": "exists" },
      "max_iterations": 20,
      "delay_ms": 1500,
      "steps": [
        { "action": "click", "selector": ".pagination .next:not(.disabled), button[aria-label='Next page']:not(:disabled)" },
        { "action": "delay", "ms": 1500 },
        { "action": "wait", "selector": "#study-list", "timeout": 15000 },
        { "action": "extract", "selector": "#study-list", "format": "json" }
      ]
    }
  ]
}
```

提取字段与 chinadrugtrials 一致：Sponsor/申请人、试验名称、状态、适应症、试验分期、登记日期。
ClinicalTrials.gov 数据为英文，你在报告中需翻译关键信息为中文。

### 数据合并

两个来源的试验数据合并规则：
- CDT 来源标记 `source: "CDT"`，CT.gov 来源标记 `source: "CT.gov"`
- 按 `登记号` 天然不冲突（CTR编号 vs NCT编号），直接合并
- 如果同一试验在两个来源都出现（极少数情况），按 Sponsor + 试验名称 去重，优先保留 chinadrugtrials 的记录（中国本土数据更准确，且有联系方式）

### 搜索完成后立即更新状态

**每个数据源搜索完成后立即更新**（不等另一个源）：

- CDT 搜索完成 → 设 `searched_cdt = true`，`searched_cdt_date = 当天`
- CT.gov 搜索完成 → 设 `searched_ctgov = true`，`searched_ctgov_date = 当天`
- `lead_count` 更新为两个来源合并后的总临床试验数
- 立即写入文件（防止中断后重复搜索）

合并两个来源的试验数据时，按 `登记号` 去重（CTR 编号 vs NCT 编号天然不冲突，无需特殊处理）。

### 提取结果格式

将每个 API 的搜索结果合并（**含企业联系方式和药物分类**）：

```json
{
  "api_name": "Duloxetine",
  "api_name_cn": "度洛西汀",
  "potency_category": 2,
  "ai_limit": "100 ng/day",
  "trials": [
    {
      "regNo": "CTR20260390",
      "source": "CDT",
      "sponsor": "浙江华海药业股份有限公司",
      "drugName": "盐酸度洛西汀肠溶胶囊",
      "drugType": "化学药品",
      "drugClassification": "仿制药",
      "status": "已完成",
      "phase": "其他-BE",
      "indication": "适用于治疗抑郁症和广泛性焦虑障碍",
      "regDate": "2026-02-03",
      "contactName": "张三",
      "contactPhone": "0571-88888888",
      "contactEmail": "zhangsan@huahai.com",
      "contactAddress": "浙江省杭州市XX区XX路XX号",
      "piName": "李四",
      "piTitle": "主任医师",
      "piUnit": "浙江大学医学院附属第一医院",
      "sites": [{"name": "XX医院", "pi": "李四", "city": "杭州"}],
      "isNew": true
    }
  ]
}
```

**CT.gov 来源的试验**提取：产品名称、剂型、联系方式。格式：
```json
{
  "regNo": "NCT03349684",
  "source": "CT.gov",
  "sponsor": "Bayer",
  "drugName": "Sitagliptin",
  "dosageForm": "口服固体制剂(片剂)",
  "drugClassification": "原研药",
  "status": "RECRUITING",
  "phase": "PHASE3",
  "indication": "Diabetes Mellitus, Type 2",
  "regDate": "2025-03-05",
  "contactName": "Zhang Wei, MD",
  "contactPhone": "+86-010-88888888",
  "contactEmail": "zhangwei@hospital.com",
  "contactAddress": "",
  "centralContactName": "Bayer Clinical Study Info Center",
  "centralContactPhone": "1-877-240-9479",
  "centralContactEmail": "info@bayer.com",
  "siteContacts": [{"facility":"XX医院","city":"Beijing","contactName":"Zhang Wei","contactPhone":"+86-010-88888888","contactEmail":"zhangwei@hospital.com"}],
  "chinaLocations": [{"facility": "XX医院", "city": "Beijing"}],
  "isNew": false
}
```

**CT.gov 产品名称提取**：
- 从 `Intervention` 字段提取 `type=DRUG` 的干预措施名称
- 优先匹配与 API 英文名一致的干预（精确匹配 > 模糊匹配 > 第一个药物干预）
- 约 80% 的 CT.gov 试验能提取到产品名

**CT.gov 剂型推断**：
- 从 `Intervention.description` + `OfficialTitle` + `BriefTitle` 关键词推断
- 英文关键词：tablet/capsule/oral/inject/inhal/nasal/cream 等
- 约 30% 的 CT.gov 试验能推断出剂型（CT.gov 描述通常不含剂型信息）

**CT.gov 联系方式提取优先级**：
1. 优先取中国试验点的 `Location.contacts`（role=CONTACT 的联系人）
2. 如无 site contact，fallback 到 `centralContacts`（研究级联系人）
3. 约 80% 的 CT.gov 试验有联系方式

**CDT 剂型提取**：
- 从 `drugName` 中文后缀自动识别：片→片剂、胶囊→胶囊、缓释→改良释放、吸入→吸入制剂 等
- 识别率约 97%
- CSP 重点关注：**口服固体制剂**（片剂/胶囊/颗粒）和**改良释放制剂**

### 增量检测

1. **首次运行**（`output/runs/` 目录下无快照文件）：
   - 过滤临床试验：仅保留 `registration_date` ≥ (当天日期 - 2年) 的记录
   - 例如当天是 2026-07-11，则只保留 2024-07-11 之后登记的试验

2. **后续运行**（`output/runs/` 目录下有最近一次的快照文件）：
   - 读取上次快照文件（如 `output/runs/2026-07-04.json`）
   - 对比本次结果与上次快照：
     - 新增 API：FDA 新列入但上次快照中没有的
     - 新增临床试验：本次搜索到但上次快照中没有的（按 申请人 + 登记日期 去重）
     - 状态变化：试验状态从"进行中"变为"已完成"等
   - 标记所有新增项

### 错误处理

- 单个 API 搜索超时：跳过，记录到 `output/runs/errors.log`，继续下一个
- 验证码出现：截图保存到 `/tmp/captcha-<api>-<timestamp>.png`，跳过该 API
- chinadrugtrials 无法触达：记录错误，标记 `searched_cdt = true`，继续（**不回退**到 CT.gov，因为 CT.gov 无论如何都会搜索）
- 搜索结果为空：正常情况，该 API 在该来源无相关临床试验

---

## Phase 3: 报告生成

### 目标

根据 Phase 1-2 的数据，参考 CSP 推荐规则，生成**面向管理层和市场部销售**的 Markdown 商机报告。

### 报告受众说明

- **管理层**：关注整体概览、高风险 API 数量、新增商机趋势
- **市场部销售**：关注具体企业联系方式、产品名称、药物分类，需要可直接触达客户的信息

### 操作步骤

1. 读取 `references/csp-recommendations.md` 中的推荐规则

2. 对每条临床试验记录：
   - 根据 API 的 potency category 查表得到推荐 CSP 方案
   - 根据试验分期估算包装需求级别
   - 根据剂型调整推荐（如有）

3. 生成 `output/CSP_Leads_Report.md`，格式如下：

```markdown
# CSP 商机发掘报告 — 亚硝胺
> 生成日期: YYYY-MM-DD | 数据来源: FDA (版本日期) + 中国药物临床试验登记与信息公示平台 + ClinicalTrials.gov
> 搜索模式: 增量/全量 | 本次新增: N 条 | 总计: M 条

## 概览
- FDA亚硝胺风险API: X个 → 中国有临床试验: Y个
- 新增（本次）: N个
- 极高风险(Cat 1): A个 | 高风险(Cat 2): B个 | 中高风险(Cat 3): C个 | 中风险(Cat 4): D个 | 低风险(Cat 5): E个
- 涉及企业: Z家

## 新增商机（本次）
### <API中文名> <API英文名> — K家企业
| 申请人 | 产品名称 | 药物分类 | 试验状态 | 适应症 | 试验分期 | 登记日期 | 联系方式 | 推荐CSP方案 |
|--------|---------|---------|---------|--------|---------|---------|---------|------------|

## 全量商机列表
### 极高风险 (Cat 1)
#### <API中文名> <API英文名>
**重点企业联系表**（有 CDT 联系信息的排前面）

| 申请人 | 产品名称 | 药物分类 | 联系人 | 电话 | 邮箱 | 地址 | 试验状态 | 适应症 | 分期 | 来源 |
|--------|---------|---------|-------|------|------|------|---------|--------|------|------|

### 高风险 (Cat 2)
...

### 中高风险 (Cat 3)
...

### 中风险 (Cat 4)
...

### 低风险 (Cat 5)
...
```

4. 保存本次运行快照到 `output/runs/YYYY-MM-DD.json`（完整数据，用于下次增量对比）

### 报告要求

- **联系方式优先**：有 CDT 联系信息（电话/邮箱/地址）的企业排在前面
- 按风险等级从高到低排列
- 新增商机在最前面单独列出
- 每个API下的企业按试验分期从高到低排列（III期 > II期 > I期）
- **药物名称**必须显示（是产品名称，不等于 API 名称）
- **药物分类**标注（仿制药/原研药/新药），无法判断则留空
- 如果某API无中国临床试验，不在报告中列出
- CT.gov 来源的试验也提取联系方式（centralContact + site contact），优先级：site > central

---
name: browser-executor
description: 真实浏览器自动化工具。使用 Playwright 在真实 Chromium 浏览器中导航、输入、点击、等待和提取网页数据。用于需要 JavaScript 渲染的网站（如中国药物临床试验登记平台）。当需要与网页进行交互式操作时使用此 skill。
---

# Browser Executor

通用浏览器自动化工具，基于 Playwright。用于在真实浏览器中执行多步骤网页操作。

## 核心概念

每次调用 `browser.js` 是一个独立进程。**页面状态无法跨调用保持**。因此使用 **script 模式**：将所有操作步骤写入一个 JSON 文件，一次性执行。

## 浏览器连接模式

支持双模式连接，通过环境变量 `BROWSER_ENDPOINT` 切换：

- **远程模式**（生产环境）：`BROWSER_ENDPOINT` 设为 browserless WebSocket 地址（如 `ws://host:3000/?token=...`）→ 使用 `chromium.connectOverCDP()` 连接远程浏览器
- **本地模式**（开发调试）：`BROWSER_ENDPOINT` 未设 → 使用 `chromium.launch()` 启动本地 Chromium

两种模式都应用相同的 stealth 伪装（详见下文）。

## 使用方法

### Script 模式（主要用法）

创建一个 JSON 脚本文件描述操作步骤，然后执行：

```bash
node skills/browser_executor/scripts/browser.js script /path/to/script.json
```

### Screenshot 模式（调试用）

```bash
node skills/browser_executor/scripts/browser.js screenshot <url> <output-path>
```

## Script JSON 格式

```json
{
  "steps": [
    { "action": "navigate", "url": "https://example.com" },
    { "action": "type", "selector": "#search-input", "text": "搜索关键词" },
    { "action": "click", "selector": "#search-button" },
    { "action": "wait", "selector": ".search-results", "timeout": 30000 },
    { "action": "select", "selector": "#page-size", "value": "-1" },
    { "action": "evaluate", "script": "document.title" },
    { "action": "delay", "ms": 2000 },
    { "action": "extract", "selector": ".result-table", "format": "json" },
    { "action": "extract", "selector": ".summary-text", "format": "text" },
    { "action": "screenshot", "path": "/tmp/debug-step.png" },
    {
      "action": "loop",
      "exit_when": { "selector": ".next.disabled", "condition": "exists" },
      "max_iterations": 20,
      "delay_ms": 1000,
      "steps": [
        { "action": "click", "selector": ".next:not(.disabled)" },
        { "action": "delay", "ms": 2000 },
        { "action": "wait", "selector": ".results", "timeout": 15000 },
        { "action": "extract", "selector": ".results", "format": "json" }
      ]
    }
  ]
}
```

## 支持的 Action

| Action | 参数 | 说明 |
|--------|------|------|
| `navigate` | `url`, `timeout`(可选), `waitUntil`(可选, 默认`domcontentloaded`), `retries`(可选, 默认3) | 导航到指定URL。**默认使用`domcontentloaded`而非`networkidle`**，因为部分网站（如chinadrugtrials）有持久连接。失败时自动重试（默认3次，每次间隔递增） |
| `type` | `selector`, `text`, `timeout`(可选) | 在输入框中填入文本 |
| `click` | `selector`, `timeout`(可选) | 点击元素 |
| `wait` | `selector`, `timeout`(可选) | 等待元素出现，默认超时30秒 |
| `select` | `selector`, `value`, `timeout`(可选) | 选择`<select>`下拉框的`<option>`。`value`为option的value属性值。DataTables的"All"选项value通常为`-1` |
| `evaluate` | `script` | 在页面上下文执行JS表达式，返回结构化JSON。多语句需用IIFE：`"(() => { return ... })()"` |
| `delay` | `ms` | 暂停指定毫秒数，用于反爬节奏控制 |
| `extract` | `selector`, `format`("json"或"text") | 提取数据。json格式会解析表格结构（二维/三维数组）或文本列表 |
| `screenshot` | `path`, `fullPage`(可选) | 截图保存到指定路径 |
| `loop` | `exit_when`, `max_iterations`, `delay_ms`, `steps` | 重复执行子步骤。详见下文 |

## loop Action 详解

`loop` 用于翻页等重复操作：

- **在每次迭代开始前**检查 `exit_when` 条件，满足则退出（不执行本次子步骤）
- 条件不满足时执行 `steps` 中的所有子步骤
- 迭代间暂停 `delay_ms` 毫秒
- `exit_when.condition` 取值：`"exists"`（selector存在时退出）或 `"missing"`（selector不存在时退出）
- 子步骤中的 `extract`/`evaluate` 结果按顺序追加到外层 `results` 数组

**翻页模式（重要）：** 首页数据在 `loop` **外部**提取，`loop` 子步骤顺序为：点击下一页 → 延时 → 等待新结果 → 提取。这样 `exit_when` 在迭代开始时检查"下一页是否可用"，避免漏提取最后一页。

## 输出

所有 `extract` 和 `evaluate` 步骤的结果按顺序组成 JSON 数组输出到 stdout。

- `format: "text"` → 返回字符串
- `format: "json"` → 返回表格数据（二维数组）或文本列表
- `evaluate` → 返回JS表达式的求值结果

## 路径说明

- 脚本路径相对于工作目录（Docker 中为 `/workspace`）
- 截图路径建议使用临时目录
- Cookie 状态自动保存在临时目录的 `browser-state.json`，跨调用保持会话

## 错误处理

- 任何步骤失败，整个脚本终止，错误信息输出到 stderr
- 建议 Pi 在遇到错误时截图调试，然后调整选择器重试

## 反检测机制（已内置）

browser.js 已内置以下反爬虫措施，两种连接模式都生效：
- 隐藏 `navigator.webdriver` 标志
- 注入伪装的 `navigator.plugins`、`navigator.languages`、`window.chrome`
- 禁用 `AutomationControlled` 特征（本地模式）
- 伪装 User-Agent 和 Accept-Language 头
- Cookie 持久化（跨调用保持会话）
- 远程模式下 browserless 自身也提供 stealth 伪装

如遇验证码，截图保存并跳过当前任务。

## 代码安全约束

当你在 SKILL.md 中编写 browser script JSON 时，必须遵守：
- **所有 `wait` 步骤必须设置 `timeout`**，禁止不设超时的等待
- **禁止使用无限循环**，`loop` 的 `max_iterations` 必须 ≤ 50，`delay_ms` 建议 ≥ 1000
- **每个 `extract` 步骤的输出必须是结构化 JSON**，禁止返回无结构的模糊字符串
- **单个脚本的执行时间不应超过 120 秒**，超时由 Playwright 自动终止
- **翻页时首页 extract 放在 loop 外部**，loop 内先点击下一页再 extract
