# 试运行问题修复设计文档

> **日期:** 2026-07-11
> **状态:** 已批准，待写实现计划
> **关联文档:** `2026-06-30-csp-lead-agent-design.md`（初始设计）
> **背景:** 首次试运行后发现4个问题，本文档描述修复方案

---

## 1. 问题描述

试运行后发现以下4个问题：

| # | 问题 | 影响 |
|---|------|------|
| 1 | FDA页面Table分页（可选"All"显示全部），系统只提取第一页 | 亚硝胺数据不完整，漏掉部分API |
| 2 | 抓取到的有效成分只有英文名 | 中国临床试验网站多数情况只能搜中文，无法有效搜索 |
| 3 | 中国临床试验数据操作未能完成（LLM反馈"无法触达"） | chinadrugtrials 无法触达；Pi 智能地改去 ClinicalTrials.gov 抓取中国地区厂商数据（值得保留为备选方案），但中国网站是优先数据源 |
| 4 | Docker镜像体积过大（含Chromium约200MB+） | 有了独立browserless，不需要本地浏览器 |

---

## 2. 修复方案

### 2.1 browser.js 增强（Issue 1 + 3 基础）

#### 2.1.1 新增4个 Action

| Action | 参数 | 用途 |
|--------|------|------|
| `select` | `selector`, `value`, `timeout`(可选) | 选择 `<select>` 下拉框的 `<option>`（用于FDA页码大小"All"）— 使用 Playwright `selectOption()` |
| `evaluate` | `script` (JS字符串) | 在页面上下文执行任意JS，返回结构化JSON（万能后备，可处理任何JS驱动的表格/控件） |
| `loop` | `exit_when` (selector + exists/missing), `max_iterations`, `delay_ms`, `steps` (子步骤数组) | 重复执行子步骤直到条件满足或达到上限 — 临床试验结果翻页 |
| `delay` | `ms` | 暂停N毫秒 — 反爬节奏控制 |

**`loop` 语义：**
- **在每次迭代开始前**检查 `exit_when` 条件，满足则退出循环（不执行本次迭代的子步骤）
- 条件不满足时，执行 `steps` 中的所有子步骤
- 迭代间暂停 `delay_ms` 毫秒（子步骤执行完毕后、下次 exit_when 检查前）
- `exit_when.condition` 取值：`"exists"`（selector 存在于DOM时退出）或 `"missing"`（selector 不存在于DOM时退出）
- 达到 `max_iterations` 强制退出（安全上限，默认20）
- 子步骤中的 `extract` 结果按顺序追加到外层 `results` 数组
- 遵守代码安全约束：`max_iterations` 必须 ≤ 50，`delay_ms` 建议 ≥ 1000

**翻页模式（重要）：** 首页数据在 `loop` **外部**提取，`loop` 子步骤顺序为：点击下一页 → 延时 → 等待新结果 → 提取。这样 `exit_when` 在迭代开始时检查"下一页是否可用"，避免漏提取最后一页数据。

#### 2.1.2 双模式浏览器连接

```javascript
// 伪代码
if (process.env.BROWSER_ENDPOINT) {
  browser = await chromium.connectOverCDP(process.env.BROWSER_ENDPOINT);
} else {
  browser = await chromium.launch({ headless: true, args: STEALTH_ARGS, ... });
}
```

- `BROWSER_ENDPOINT` 环境变量设了 → 连远程 browserless（`chromium.connectOverCDP()`）
- 未设 → 本地启动（`chromium.launch()`），用于本地开发/调试
- 两种模式都创建自定义 context（locale `zh-CN`，伪装 UA，`Accept-Language` 头）
- 两种模式都注入 stealth init scripts（隐藏 `navigator.webdriver`，伪装 plugins/languages，设置 `window.chrome`）
- Cookie 持久化（`/tmp/browser-state.json`）在两种模式下都生效

**Stealth 最强伪装策略（远程模式）：**
- browserless URL 追加 `&stealth=true`（browserless 内置 stealth）
- 自定义 context 设置（locale, UA, headers）
- init scripts 注入（navigator 属性伪装）
- 三层叠加 = 最强伪装

#### 2.1.3 navigate waitUntil 修复

- **问题：** 当前 `navigate` 使用 `networkidle`，chinadrugtrials 有持久连接（WebSocket/长轮询），`networkidle` 永远不会触发完成，导致超时（"无法触达"）
- **修复：** 默认改为 `domcontentloaded`，每个 `navigate` 步骤可通过 `waitUntil` 字段覆盖

```json
{ "action": "navigate", "url": "...", "timeout": 60000, "waitUntil": "domcontentloaded" }
```

---

### 2.2 FDA Table 分页修复（Issue 1）

更新 SKILL.md 中 FDA 抓取脚本模板：

```json
{
  "steps": [
    { "action": "navigate", "url": "https://www.fda.gov/.../cder-nitrosamine-impurity-acceptable-intake-limits#predicted", "timeout": 60000 },
    { "action": "wait", "selector": "table", "timeout": 60000 },
    { "action": "select", "selector": "select[name*='_length']", "value": "-1" },
    { "action": "wait", "selector": "table tbody tr", "timeout": 30000 },
    { "action": "extract", "selector": "table", "format": "json" }
  ]
}
```

- `select` 的 `value: "-1"` 对应 DataTables 的 "All" 选项
- 选择"All"后所有行渲染到DOM，单次 `extract` 获取全部数据
- `select` 选择器为推测值，SKILL.md 指示 LLM 先截图分析实际HTML结构再调整

---

### 2.3 中英双语 API 名称（Issue 2）

#### 2.3.1 翻译查找表

- 解析 `20260616_6月上新亚硝胺药物分析杂质.md` 中的中英对照对（格式：`中文名 EnglishName`）
- 生成 `config/api_translations.json` 结构化查找表：

```json
{
  "Ambroxol": "氨溴索",
  "Atenolol": "阿替洛尔",
  "Metoprolol": "美托洛尔",
  "...": "..."
}
```

- 参考文件包含约100对API名称，覆盖FDA列表中大多数API

#### 2.3.2 缓存 Schema 更新

`config/fda_nitrosamines.json` 中每个 API 对象新增 `name_cn` 字段：

```json
{
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

#### 2.3.3 翻译流程

Phase 1（FDA数据采集）中：
1. 从FDA提取API英文名后，查 `config/api_translations.json`
2. 找到 → 填入 `name_cn`
3. 未找到 → LLM翻译一次 → 填入 `name_cn` 并缓存（后续运行不重复翻译）
4. LLM翻译失败 → `name_cn` 设为 `null`，Phase 2 跳过该API

Phase 2（临床试验搜索）中：
- 优先用 `name_cn` 搜索 chinadrugtrials（中文网站多数只能搜中文）
- `name_cn` 为 null 的API跳过并记录到 errors.log

---

### 2.4 中国临床试验搜索修复（Issue 3）

#### 2.4.1 连接修复

- 通过独立 browserless 连接（`ws://ssuzaip38.aptargroup.loc:3000/?token=...`）
- browserless 在企业内网（`aptargroup.loc`），可访问 chinadrugtrials.org.cn
- `domcontentloaded` 替代 `networkidle`，解决超时问题
- Stealth 三层伪装（见 2.1.2）

#### 2.4.2 搜索脚本模板更新

```json
{
  "steps": [
    { "action": "navigate", "url": "https://www.chinadrugtrials.org.cn/clinicaltrials.searchlist.dhtml", "timeout": 60000 },
    { "action": "wait", "selector": "input[name='keywords']", "timeout": 30000 },
    { "action": "type", "selector": "input[name='keywords']", "text": "API中文名" },
    { "action": "click", "selector": "input[type='submit'], button[type='submit'], .search-btn" },
    { "action": "delay", "ms": 2000 },
    { "action": "wait", "selector": ".list, .result, table", "timeout": 30000 },
    { "action": "extract", "selector": ".list, .result, table", "format": "json" },
    {
      "action": "loop",
      "exit_when": { "selector": ".next.disabled, .pagination .disabled", "condition": "exists" },
      "max_iterations": 20,
      "delay_ms": 1000,
      "steps": [
        { "action": "click", "selector": ".next:not(.disabled), a.next:not(.disabled)" },
        { "action": "delay", "ms": 2000 },
        { "action": "wait", "selector": ".list, .result, table", "timeout": 15000 },
        { "action": "extract", "selector": ".list, .result, table", "format": "json" }
      ]
    }
  ]
}
```

- **重要：** 选择器为推测值，SKILL.md 指示 LLM 先截图分析实际HTML结构再调整
- 首页 `extract` 在 `loop` 外部，`loop` 内子步骤为：点击下一页 → 延时2秒 → 等待 → 提取
- `exit_when` 在每次迭代开始前检查：下一页按钮是否 disabled，是则退出（首页已提取，不会漏数据）
- `delay` 在搜索和翻页间增加2秒间隔，降低被反爬检测概率

#### 2.4.3 备选方案：ClinicalTrials.gov 回退

试运行中 Pi 智能地在 chinadrugtrials 不可达时改用 ClinicalTrials.gov（美国临床试验数据库）抓取中国地区厂商的试验数据。此行为值得保留并正式化为回退策略。

**搜索优先级：**
1. **主源：** chinadrugtrials.org.cn — 中国本土数据，覆盖最全（通过 browserless 连接，stealth 伪装）
2. **备选：** ClinicalTrials.gov — 搜索条件加 `Location: China`，提取 Sponsor 为中国厂商的试验

**回退触发条件：**
- chinadrugtrials 页面加载超时（`navigate` 超时）
- chinadrugtrials 出现验证码（截图确认后跳过）
- chinadrugtrials 搜索结果为空但不应为空（API 有中国临床试验的可能性高）

**ClinicalTrials.gov 搜索脚本模板：**
```json
{
  "steps": [
    { "action": "navigate", "url": "https://clinicaltrials.gov/search?term=API_NAME&locStr=China", "timeout": 60000 },
    { "action": "wait", "selector": "#study-list", "timeout": 30000 },
    { "action": "extract", "selector": "#study-list", "format": "json" },
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

- ClinicalTrials.gov 是美国政府网站，反爬较弱，`domcontentloaded` 足够
- 搜索 URL 中 `term=API_NAME` 用英文名（该站支持英文搜索），`locStr=China` 限定中国地区
- 提取字段与 chinadrugtrials 一致：Sponsor/申请人、试验名称、状态、适应症、试验分期、登记日期
- ClinicalTrials.gov 数据为英文，LLM 在报告中需翻译关键信息为中文

**数据合并：** 如果同时从两个来源获取到同一API的试验数据，按 Sponsor + 试验名称 去重，优先保留 chinadrugtrials 的记录（中国本土数据更准确）。

#### 2.4.4 增量检测（3年首次 + 后续增量）

- **首次运行**（`output/runs/` 无快照文件）：
  - 过滤临床试验：仅保留 `registration_date` ≥ (当天 - 3年) 的记录
  - 在 SKILL.md 中明确此规则
- **后续运行**（`output/runs/` 有快照文件）：
  - 对比上次快照，仅标记新增临床试验（按 申请人 + 登记日期 去重）
  - 标记状态变化（如"进行中" → "已完成"）
  - 不重新提取已搜索过的API的完整数据（断点续传机制已处理）

---

### 2.5 Docker 瘦身（Issue 4）

#### Dockerfile 修改

```dockerfile
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=true
ENV NODE_PATH=/usr/local/lib/node_modules

RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent
RUN npm install -g playwright

WORKDIR /workspace
ENTRYPOINT ["pi"]
```

变更：
- 移除 `chromium` 和 `fonts-wqy-zenhei`（约200MB+节省）
- 移除 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`（不再需要本地浏览器路径）
- 保留 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=true`（不需要下载浏览器二进制）
- 保留 `npm install -g playwright`（`connectOverCDP` 客户端API需要）
- 保留 `bash ca-certificates git ripgrep`

#### docker-compose.yml 修改

```yaml
services:
  csp-agent:
    build: .
    environment:
      - DASHSCOPE_API_KEY=${DASHSCOPE_API_KEY}
      - BROWSER_ENDPOINT=${BROWSER_ENDPOINT}
    volumes:
      - .:/workspace
      - pi-agent-home:/root/.pi/agent
      - ./config/models.json:/root/.pi/agent/models.json:ro
    stdin_open: true
    tty: true

volumes:
  pi-agent-home:
```

#### .env.example 修改

```
DASHSCOPE_API_KEY=
BROWSER_ENDPOINT=ws://ssuzaip38.aptargroup.loc:3000/?token=PW8rJqSTzd
```

---

## 3. 文件变更清单

| 文件 | 变更类型 | 内容 |
|------|----------|------|
| `skills/browser_executor/scripts/browser.js` | 修改 | 新增4个action（select/evaluate/loop/delay）、双模式连接、waitUntil可配置 |
| `skills/browser_executor/SKILL.md` | 修改 | 文档化新action、更新代码安全约束 |
| `scenarios/nitrosamine/SKILL.md` | 修改 | FDA脚本加select("All")、缓存schema加name_cn、临床试验脚本加loop翻页、chinadrugtrials主源+ClinicalTrials.gov备选回退、增量检测3年规则 |
| `Dockerfile` | 修改 | 移除chromium+fonts、移除EXECUTABLE_PATH |
| `docker-compose.yml` | 修改 | 添加BROWSER_ENDPOINT环境变量 |
| `.env.example` | 修改 | 添加BROWSER_ENDPOINT |
| `config/api_translations.json` | 新增 | 从20260616参考文件解析的中英对照表 |

---

## 4. 验证标准

1. **FDA数据完整性：** 抓取的API数量 ≥ 100（之前只提取第一页约10-25个）
2. **中英双语：** `config/fda_nitrosamines.json` 中每个API都有 `name_cn`（非null）
3. **临床试验可触达：** browser.js通过browserless成功连接chinadrugtrials.org.cn，页面正常加载
4. **翻页：** `loop` action成功提取多页临床试验结果
5. **备选回退：** chinadrugtrials不可达时，自动回退到ClinicalTrials.gov搜索中国地区厂商试验
6. **增量检测：** 首次运行获取3年内数据；第二次运行只标记增量
7. **Docker体积：** 镜像体积减少约200MB+（移除chromium和fonts）
8. **代码安全：** 所有新action遵守现有约束（timeout必设、无无限循环、extract返回结构化JSON、单脚本≤120s）

---

## 5. 风险与缓解

| 风险 | 缓解 |
|------|------|
| FDA页面选择器变化 | SKILL.md指示LLM先截图分析实际HTML再调整选择器 |
| chinadrugtrials反爬升级 | browserless stealth + 延时2秒 + 验码截图跳过；不可达时回退ClinicalTrials.gov |
| 参考文件未覆盖所有API | LLM翻译回退，结果缓存避免重复翻译 |
| browserless服务不可用 | 双模式：本地开发可不用browserless；生产环境需确保browserless可用 |
| ClinicalTrials.gov选择器变化 | SKILL.md指示LLM先截图分析实际HTML再调整选择器 |
| `evaluate` action安全风险 | SKILL.md代码安全约束：结构化JSON输出、无无限循环、单脚本≤120s |
