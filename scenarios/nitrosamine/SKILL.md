---
name: nitrosamine
description: 亚硝胺药物商机发掘场景。从FDA页面抓取亚硝胺杂质风险API列表，在中国药物临床试验登记平台搜索相关临床试验，匹配客户画像并生成CSP产品推荐报告。当需要执行亚硝胺相关的商机发掘时使用此 skill。
---

# 亚硝胺商机发掘场景

## 概述

本场景执行三阶段 pipeline：
1. 从 FDA 页面抓取亚硝胺杂质和对应 API 列表
2. 逐一在中国药物临床试验登记平台搜索相关临床试验
3. 生成包含 CSP 产品推荐的 Markdown 商机报告

## 前置条件

- 已加载 `browser-executor` skill
- Docker 容器已启动，Playwright/Chromium 可用
- `DASHSCOPE_API_KEY` 已配置

---

## Phase 1: FDA 数据采集

### 目标

从 FDA 页面解析 Table 1，提取所有亚硝胺杂质记录及其对应的 API。

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

5. 构建结构化数据并写入 `config/fda_nitrosamines.json`。**使用状态机格式**（每个 API 独立跟踪搜索状态）：

```json
{
  "last_updated": "2026-06-30",
  "fda_page_version": "2026-03-19",
  "apis": {
    "Atenolol": {
      "limit": "1500 ng/day",
      "potency_category": 4,
      "fda_detected_at": "2026-06-30",
      "china_trial_searched": false,
      "china_trial_last_search": null,
      "lead_count": 0
    },
    "Metoprolol": {
      "limit": "1500 ng/day",
      "potency_category": 4,
      "fda_detected_at": "2026-06-30",
      "china_trial_searched": true,
      "china_trial_last_search": "2026-06-23",
      "lead_count": 2
    }
  }
}
```

**关键：保留上次运行中已存在的 API 状态**。如果某个 API 上次已搜索过（`china_trial_searched: true`），更新其 FDA 数据但保留搜索状态。仅对 `china_trial_searched: false` 的新增 API 执行 Phase 2 搜索。

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
1. 用英文名搜索（部分平台支持英文搜索）
2. 如果英文搜索无结果，用中文名搜索（你需要根据英文名推断中文名）
3. 如果都无结果，跳过该 API 并记录

### chinadrugtrials 搜索流程

搜索页面 URL：`https://www.chinadrugtrials.org.cn/clinicaltrials.searchlist.dhtml`

1. 创建 browser script JSON 文件（如 `/tmp/trial-search.json`）：

```json
{
  "steps": [
    {
      "action": "navigate",
      "url": "https://www.chinadrugtrials.org.cn/clinicaltrials.searchlist.dhtml",
      "timeout": 60000
    },
    {
      "action": "wait",
      "selector": "input[name='keywords']",
      "timeout": 30000
    },
    {
      "action": "type",
      "selector": "input[name='keywords']",
      "text": "API_NAME_HERE"
    },
    {
      "action": "click",
      "selector": "input[type='submit'], button[type='submit'], .search-btn"
    },
    {
      "action": "wait",
      "selector": ".list, .result, table",
      "timeout": 30000
    },
    {
      "action": "extract",
      "selector": ".list, .result, table",
      "format": "json"
    }
  ]
}
```

2. **重要**：你需要先访问一次搜索页面，截图分析实际的 HTML 结构，然后调整上述选择器。选择器可能因网站更新而变化。

3. 对每个 API 执行搜索脚本，提取以下字段：
   - 申请人/申办者
   - 试验名称/药物名称
   - 试验状态（如：进行中、已完成、已招募）
   - 适应症
   - 试验分期（I期、II期、III期、IV期）
   - 主要研究者
   - 试验机构
   - 登记日期

4. 如果搜索结果有多页，需要翻页提取（创建包含多次点击"下一页"和提取的脚本）

5. **搜索完成后立即更新状态**：将该 API 在 `config/fda_nitrosamines.json` 中的 `china_trial_searched` 设为 `true`，`china_trial_last_search` 设为当天日期，`lead_count` 设为找到的临床试验数，写入文件。这样即使后续中断，下次运行也会跳过已搜索的 API。

### 提取结果格式

将每个 API 的搜索结果合并为：

```json
{
  "api_name": "Atenolol",
  "api_name_cn": "阿替洛尔",
  "potency_category": 4,
  "ai_limit": "1500 ng/day",
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

1. 读取 `output/runs/` 目录下最近一次的快照文件（如 `output/runs/2026-06-23.json`）
2. 对比本次结果与上次快照：
   - 新增 API：FDA 新列入但上次快照中没有的
   - 新增临床试验：本次搜索到但上次快照中没有的（按申请人+登记日期去重）
   - 状态变化：试验状态从"进行中"变为"已完成"等
3. 标记所有新增项

### 错误处理

- 单个 API 搜索超时：跳过，记录到 `output/runs/errors.log`，继续下一个
- 验证码出现：截图保存到 `/tmp/captcha-<api>-<timestamp>.png`，跳过该 API
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

5. 如果 `WEBHOOK_URL` 环境变量已配置，执行通知脚本推送简报到企业微信/钉钉群：
```bash
bash scripts/notify.sh output/CSP_Leads_Report.md
```

### 报告要求

- 按风险等级从高到低排列
- 新增商机在最前面单独列出
- 每个API下的企业按试验分期从高到低排列（III期 > II期 > I期）
- 如果某API无中国临床试验，不在报告中列出
