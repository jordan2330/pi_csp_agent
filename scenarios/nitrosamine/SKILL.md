---
name: nitrosamine
description: 亚硝胺药物商机发掘场景。从FDA页面抓取亚硝胺杂质风险API列表，在中国药物临床试验登记平台搜索相关临床试验，匹配客户画像并生成CSP产品推荐报告。当需要执行亚硝胺相关的商机发掘时使用此 skill。
---

# 亚硝胺商机发掘场景

## 概述

本场景执行三阶段 pipeline：
1. 从 FDA 页面抓取亚硝胺杂质和对应 API 列表（含中英文名称）
2. 逐一在中国药物临床试验登记平台搜索相关临床试验（chinadrugtrials为主源，ClinicalTrials.gov为备选）
3. 生成包含 CSP 产品推荐的 Markdown 商机报告

## 前置条件

- 已加载 `browser-executor` skill
- Docker 容器已启动，`BROWSER_ENDPOINT` 已配置（指向独立 browserless）
- `DASHSCOPE_API_KEY` 已配置

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

6. 构建结构化数据并写入 `config/fda_nitrosamines.json`。**使用状态机格式**（每个 API 独立跟踪搜索状态）：

```json
{
  "last_updated": "2026-07-11",
  "fda_page_version": "2026-03-19",
  "apis": {
    "Atenolol": {
      "name_cn": "阿替洛尔",
      "limit": "1500 ng/day",
      "potency_category": 4,
      "fda_detected_at": "2026-07-11",
      "china_trial_searched": false,
      "china_trial_last_search": null,
      "lead_count": 0
    }
  }
}
```

**关键：保留上次运行中已存在的 API 状态**。如果某个 API 上次已搜索过（`china_trial_searched: true`），更新其 FDA 数据和 `name_cn` 但保留搜索状态。仅对 `china_trial_searched: false` 的新增 API 执行 Phase 2 搜索。

### 错误处理

- 如果 FDA 页面无法访问，重试 3 次
- 仍失败则使用 `config/fda_nitrosamines.json` 中的缓存数据，并在报告中注明使用了缓存

---

## Phase 2: 中国临床试验搜索

### 目标

对每个**未搜索过的** API（`china_trial_searched: false`）在 chinadrugtrials.org.cn 搜索相关临床试验，提取申请人信息。

### 断点续传机制

读取 `config/fda_nitrosamines.json`，跳过所有 `china_trial_searched: true` 的 API。仅对 `china_trial_searched: false` 的 API 执行搜索。搜索完成后立即更新该 API 的状态为 `china_trial_searched: true` 并写入文件，防止中断后重复搜索。

### 搜索策略

对 `fda_nitrosamines.json` 中每个 `china_trial_searched: false` 的 API：
1. **主源搜索**：用 `name_cn`（中文名）在 chinadrugtrials.org.cn 搜索（中文网站多数只能搜中文）
2. **备选回退**：如果 chinadrugtrials 无法触达（超时/验证码）或搜索结果为空，改用 ClinicalTrials.gov 搜索（用英文名 + `locStr=China` 限定中国地区）
3. 如果两个来源都无结果，跳过该 API 并记录

### chinadrugtrials 搜索流程（主源）

搜索页面 URL：`https://www.chinadrugtrials.org.cn/clinicaltrials.searchlist.dhtml`

#### 推荐方式：使用 cdt-search.js 脚本

`skills/browser_executor/scripts/cdt-search.js` 是专用搜索脚本，自动完成搜索、翻页和详情页提取：

```bash
node skills/browser_executor/scripts/cdt-search.js "API中文名" /tmp/cdt-result.json [--max-details 30] [--max-pages 10]
```

- `--max-details N`：最多获取 N 条详情页（默认30，设0=全部）。详情页含申请人名称，但每条需单独加载，大量结果时会很慢
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

对每条搜索结果，提取以下字段：
- **申请人名称**（来自详情页 Table 0）
- 登记号（CTR编号）
- 试验状态（进行中/已完成/尚未招募）
- 药物名称
- 适应症
- 试验通俗题目
- 试验分期（I期/II期/III期/IV期/其它-BE）
- 主要研究者姓名和单位
- 试验机构列表（名称+城市）
- 首次公示信息日期
- 伦理审批日期

### ClinicalTrials.gov 回退流程（备选）

当 chinadrugtrials 无法触达或搜索结果为空时，改用 ClinicalTrials.gov：

1. 搜索 URL：`https://clinicaltrials.gov/search?term=API英文名&locStr=China`
2. ClinicalTrials.gov 是美国政府网站，反爬较弱
3. 创建 browser script JSON（如 `/tmp/trial-search-fallback.json`）：

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

4. 提取字段与 chinadrugtrials 一致：Sponsor/申请人、试验名称、状态、适应症、试验分期、登记日期
5. ClinicalTrials.gov 数据为英文，你在报告中需翻译关键信息为中文

### 数据合并

如果同时从两个来源获取到同一API的试验数据，按 Sponsor + 试验名称 去重，优先保留 chinadrugtrials 的记录（中国本土数据更准确）。

### 搜索完成后立即更新状态

将该 API 在 `config/fda_nitrosamines.json` 中的 `china_trial_searched` 设为 `true`，`china_trial_last_search` 设为当天日期，`lead_count` 设为找到的临床试验数，写入文件。这样即使后续中断，下次运行也会跳过已搜索的 API。

### 提取结果格式

将每个 API 的搜索结果合并为：

```json
{
  "api_name": "Atenolol",
  "api_name_cn": "阿替洛尔",
  "potency_category": 4,
  "ai_limit": "1500 ng/day",
  "source": "chinadrugtrials",
  "trials": [
    {
      "sponsor": "XX制药有限公司",
      "drug_name": "阿替洛尔片",
      "status": "进行中",
      "indication": "高血压",
      "phase": "III期",
      "investigator": "张某某",
      "site": "北京XX医院",
      "registration_date": "2025-03-15"
    }
  ]
}
```

### 增量检测

1. **首次运行**（`output/runs/` 目录下无快照文件）：
   - 过滤临床试验：仅保留 `registration_date` ≥ (当天日期 - 3年) 的记录
   - 例如当天是 2026-07-11，则只保留 2023-07-11 之后登记的试验

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
- chinadrugtrials 无法触达：自动回退到 ClinicalTrials.gov
- 搜索结果为空：正常情况，该 API 无相关临床试验

---

## Phase 3: 报告生成

### 目标

根据 Phase 1-2 的数据，参考 CSP 推荐规则，生成 Markdown 商机报告。

### 操作步骤

1. 读取 `references/csp-recommendations.md` 中的推荐规则

2. 对每条临床试验记录：
   - 根据 API 的 potency category 查表得到推荐 CSP 方案
   - 根据试验分期估算包装需求级别
   - 根据剂型调整推荐（如有）

3. 生成 `output/CSP_Leads_Report.md`，格式如下：

```markdown
# CSP 商机发掘报告 — 亚硝胺
> 生成日期: YYYY-MM-DD | 数据来源: FDA (版本日期) + 中国药物临床试验登记与信息公示平台
> 本次新增: N 条 | 总计: M 条

## 概览
- FDA亚硝胺风险API: X个 → 中国有临床试验: Y个
- 新增（本次）: N个
- 极高风险(Cat 1): A个 | 高风险(Cat 2): B个 | 中高风险(Cat 3): C个 | 中风险(Cat 4): D个 | 低风险(Cat 5): E个

## 新增商机（本次）
### <API中文名> <API英文名> — K家企业
| 申请人 | 试验状态 | 适应症 | 试验分期 | 登记日期 | FDA风险等级 | 推荐CSP方案 |
|--------|---------|--------|---------|---------|------------|------------|
| ...    | ...      | ...    | ...     | ...     | Cat N      | ...        |

## 全量商机列表
### 极高风险 (Cat 1)
（表格同上）

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

- 按风险等级从高到低排列
- 新增商机在最前面单独列出
- 每个API下的企业按试验分期从高到低排列（III期 > II期 > I期）
- 如果某API无中国临床试验，不在报告中列出
