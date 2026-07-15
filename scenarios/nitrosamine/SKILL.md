---
name: nitrosamine
description: 亚硝胺药物商机发掘场景。从FDA页面抓取亚硝胺杂质风险API列表，在chinadrugtrials和ClinicalTrials.gov双源搜索相关临床试验，匹配客户画像并生成含企业联系方式和CSP产品推荐的商机报告。当需要执行亚硝胺相关的商机发掘时使用此 skill。
---

# 亚硝胺商机发掘场景

## 概述

本场景执行三阶段 pipeline，**通过脚本自动化完成**，agent 仅负责编排和异常处理：

1. **Phase 1**: FDA 数据采集（仅首次运行或缓存过期时，通过浏览器抓取 FDA 页面）
2. **Phase 2**: 双源搜索（CT.gov REST API + CDT 浏览器脚本）—— **由 `run-pipeline.js` 自动执行**
3. **Phase 3**: 快照生成 + 报告生成 —— **由 `run-pipeline.js` 自动执行**

## 前置条件

- 已加载 `browser-executor` skill
- Docker 容器已启动，`BROWSER_ENDPOINT` 已配置（指向独立 browserless）
- `DASHSCOPE_API_KEY` 已配置

---

## Phase 0: 环境检查与配置读取

### 1. 检查搜索模式

读取 `config/search-config.json`：

```json
{
  "search_mode": "incremental"
}
```

- **`"full"`**（全量模式）：重置所有 API 搜索状态，重新搜索两个数据源，完成后自动改回 `"incremental"`
- **`"incremental"`**（增量模式，默认）：仅搜索未完成的 API × 数据源组合

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

### 执行方式（重要：CDT 搜索可能耗时 2-3 小时）

由于 CDT 浏览器搜索较慢，必须使用**后台执行 + 轮询**模式：

```bash
# 1. 后台启动 pipeline
nohup node scripts/run-pipeline.js nitrosamine > /workspace/output/runs/pipeline.log 2>&1 &
echo "Pipeline PID: $!"
```

然后每隔 2 分钟检查进度：
```bash
# 检查是否还在运行
kill -0 <PID> 2>/dev/null && echo "运行中" || echo "已完成"

# 查看最新日志
tail -5 /workspace/output/runs/pipeline.log
```

当 pipeline 完成后（进程不存在），检查输出：
```bash
tail -20 /workspace/output/runs/pipeline.log
```

**注意**：如果 CT.gov 和 CDT 都已经搜索完成（增量模式下待搜索为 0），pipeline 会在 1 秒内完成，无需后台执行。可以先同步尝试，超时后再转后台。

### 脚本自动完成的流程

#### Phase 2a: CT.gov REST API 搜索
- 使用 `https://clinicaltrials.gov/api/v2/studies` REST API（不是浏览器）
- 每个 API 用英文名搜索，限定 `locStr=China`
- 提取：产品名称（Intervention.name）、剂型（Intervention.description 推断）、联系方式（centralContacts + Location.contacts）
- 日期过滤：仅保留 2 年内的试验
- 每个 API 间隔 800ms，约 5-8 分钟完成全部 251 个 API

#### Phase 2b: CDT 浏览器搜索
- 调用 `skills/browser_executor/scripts/cdt-search.js` 逐 API 搜索
- 用中文名搜索，提取：产品名称（drugName）、剂型（中文后缀识别）、企业联系方式
- 每 API 参数：`--max-details 20 --max-pages 5`
- 约 2-3 小时完成全部 251 个 API

#### Phase 3: 快照 + 报告
- 从 `config/fda_nitrosamines.json` 生成快照到 `output/runs/YYYY-MM-DD.json`
- 调用 `scripts/lib/report.js`（通用渲染器，由 `scenarios/nitrosamine/scenario.json` + `enrich.js` 驱动）生成 Markdown 报告
- 报告输出到 `output/CSP_Leads_Report.md`

### 脚本退出码

- `0` — 成功完成
- `1` — FDA 数据不存在（需先执行 Phase 1）
- 其他 — 脚本内部错误

### 全量模式自动回退

如果 `search_mode` 为 `"full"`：
- 脚本会重置所有 API 的搜索状态
- 完成搜索后**自动将 `search_mode` 改回 `"incremental"`**
- 无需人工干预

---

## 运行完成后的操作

Pipeline 脚本执行完毕后：

1. **读取报告**：`cat output/CSP_Leads_Report.md`，向用户汇报结果摘要
2. **检查错误日志**：`cat output/runs/errors.log`（如存在），汇报失败的 API
3. **输出总结**：
   - 总 API 数量 / 有临床试验的 API 数量
   - 总商机数量 / 新增商机数量
   - 数据源分布（CDT / CT.gov 各多少条）
   - 剂型分布概要
   - 搜索耗时

---

## 日常运维

### 定时运行（headless 模式）

```bash
# 增量模式（默认），只搜索新 API
docker compose run --rm csp-agent pi -p "/lead-scan nitrosamine"

# 全量模式（需要先改配置）
# 1. 编辑 config/search-config.json，search_mode 改为 "full"
# 2. 运行
docker compose run --rm csp-agent pi -p "/lead-scan nitrosamine"
```

### 手动触发单源重扫

单源重扫通过重置游标 + 运行 pipeline 实现：

```bash
# 重扫 CT.gov（保留 CDT 数据）：清除 CT.gov 结果
node -e "const fs=require('fs'),p='config/fda_nitrosamines.json',d=JSON.parse(fs.readFileSync(p));Object.values(d.apis).forEach(a=>{a.results=(a.results||[]).filter(r=>r.source!=='CT.gov');a.lead_count=a.results.length});fs.writeFileSync(p,JSON.stringify(d,null,2))"
node scripts/run-pipeline.js nitrosamine

# 重扫 CDT（保留 CT.gov 数据）：重置所有 CDT 游标
node -e "const fs=require('fs'),p='config/fda_nitrosamines.json',d=JSON.parse(fs.readFileSync(p));Object.values(d.apis).forEach(a=>{a.last_cdt_regno='';a.results=(a.results||[]).filter(r=>r.source!=='CDT');a.lead_count=a.results.length});fs.writeFileSync(p,JSON.stringify(d,null,2))"
node scripts/run-pipeline.js nitrosamine

# 全量从零重置（重置所有游标 + 双源重扫 + 报告）
# 设置 search_mode=full 即可，pipeline 会自动重置所有游标
echo '{"search_mode":"full"}' > config/search-config.json
node scripts/run-pipeline.js nitrosamine
```

### 数据文件说明

| 文件 | 作用 |
|------|------|
| `config/fda_nitrosamines.json` | 核心数据库：API 列表 + 搜索状态 + 试验结果 |
| `config/search-config.json` | 搜索模式控制（full / incremental） |
| `config/api_translations.json` | API 英文名 → 中文名映射 |
| `scenarios/nitrosamine/scenario.json` | 场景声明式配置（标题/表头列/CSP推荐矩阵/缓存与报告路径） |
| `scenarios/nitrosamine/enrich.js` | 场景专属 hooks（药物分类、CSP推荐、报告小标题等，由 `scripts/lib/report.js` 调用） |
| `scripts/lib/` | 通用层：`sources.js`(双源采集) / `enrichment.js`(剂型检测) / `snapshot.js`(快照+增量) / `report.js`(通用渲染器) |
| `output/runs/YYYY-MM-DD.json` | 运行快照（用于增量对比） |
| `output/runs/errors.log` | 搜索错误日志 |
| `output/CSP_Leads_Report.md` | 最终商机报告 |

### 双源搜索状态跟踪

增量搜索机制：

- **CT.gov**: 每次运行都拉取全部结果（~5分钟/251API），通过对比缓存中的 NCT ID 检测新增试验
- **CDT**: 每个 API 记录 `last_cdt_regno` 游标（最大 regNo），增量搜索时只获取游标之后的新数据，遇到旧数据自动停止翻页
- `search_mode: "full"` 重置所有游标并全量重搜，完成后自动切回 `incremental`

两个来源完全独立。CDT 的增量效率极高——无新增时只需翻 1-2 页即停。
