# Tasks 4-6: SKILL.md files + csp-recommendations.md

Three markdown instruction files to create. All content is specified exactly in the plan.

## Task 4: Create skills/browser_executor/SKILL.md

```markdown
---
name: browser-executor
description: 真实浏览器自动化工具。使用 Playwright 在真实 Chromium 浏览器中导航、输入、点击、等待和提取网页数据。用于需要 JavaScript 渲染的网站（如中国药物临床试验登记平台）。当需要与网页进行交互式操作时使用此 skill。
---

# Browser Executor

通用浏览器自动化工具，基于 Playwright。用于在真实浏览器中执行多步骤网页操作。

## 核心概念

每次调用 `browser.js` 是一个独立进程。**页面状态无法跨调用保持**。因此使用 **script 模式**：将所有操作步骤写入一个 JSON 文件，一次性执行。

## 使用方法

### Script 模式（主要用法）

创建一个 JSON 脚本文件描述操作步骤，然后执行：

```bash
node scripts/browser.js script /path/to/script.json
```

### Screenshot 模式（调试用）

```bash
node scripts/browser.js screenshot <url> <output-path>
```

## Script JSON 格式

```json
{
  "steps": [
    { "action": "navigate", "url": "https://example.com" },
    { "action": "type", "selector": "#search-input", "text": "搜索关键词" },
    { "action": "click", "selector": "#search-button" },
    { "action": "wait", "selector": ".search-results", "timeout": 30000 },
    { "action": "extract", "selector": ".result-table", "format": "json" },
    { "action": "extract", "selector": ".summary-text", "format": "text" },
    { "action": "screenshot", "path": "/tmp/debug-step.png" }
  ]
}
```

## 支持的 Action

| Action | 参数 | 说明 |
|--------|------|------|
| `navigate` | `url`, `timeout`(可选) | 导航到指定URL，等待networkidle |
| `type` | `selector`, `text`, `timeout`(可选) | 在输入框中填入文本 |
| `click` | `selector`, `timeout`(可选) | 点击元素 |
| `wait` | `selector`, `timeout`(可选) | 等待元素出现，默认超时30秒 |
| `extract` | `selector`, `format`("json"或"text") | 提取数据。json格式会解析表格结构 |
| `screenshot` | `path`, `fullPage`(可选) | 截图保存到指定路径 |

## 输出

所有 `extract` 步骤的结果按顺序组成 JSON 数组输出到 stdout。

- `format: "text"` → 返回字符串
- `format: "json"` → 返回表格数据（二维数组）或文本列表

## 路径说明

- 脚本路径相对于 `/workspace`（Docker 中的工作目录）
- 截图路径建议使用 `/tmp/` 目录
- Cookie 状态自动保存在 `/tmp/browser-state.json`，跨调用保持登录状态

## 错误处理

- 任何步骤失败，整个脚本终止，错误信息输出到 stderr
- 建议 Pi 在遇到错误时截图调试，然后调整选择器重试
```

## Task 5: Create scenarios/nitrosamine/references/csp-recommendations.md

```markdown
# CSP 产品推荐规则 — 按亚硝胺风险等级

## 推荐矩阵

| FDA Potency Category | AI Limit (ng/day) | 风险等级 | 推荐 CSP 方案 | 理由 |
|---------------------|-------------------|---------|-------------|------|
| Cat 1 | 26.5 | 极高 | Activ-Blister® | 单格独立微气候控制，FDA已批准用于高风险口服固体；每格同步控制湿度和氧气，降解产物增长率降低2-3倍 |
| Cat 2 | 100 | 高 | Activ-Blister® | 同上，适用于高敏感口服固体的亚硝胺风险控制 |
| Cat 3 | 400 | 中高 | 3-Phase Activ-Polymer™ | 双功能活性层（除湿+除氧），兼容现有注塑/挤出工艺；可嵌入泡罩或瓶体 |
| Cat 4 | 1500 | 中 | 3-Phase Activ-Polymer™ 或 Activ-Vial® | 按包装形态选择：泡罩→3-Phase，瓶装→Activ-Vial® |
| Cat 5 | 1500 | 低 | Activ-Vial® / Activ-Film® | 瓶装选 Activ-Vial®（省去二次装配，降低包装体积40-60%）；柔性包装选 Activ-Film® |

## 附加推荐逻辑

### 按药品剂型

| 剂型 | 推荐方案 | 说明 |
|------|---------|------|
| 口服固体（片剂/胶囊）| 按上表 potency category 推荐 | 主要场景 |
| 透皮贴剂 | Activ-Film® | 薄膜形式提供湿度与氧气双重保护 |
| 益生菌 | Activ-Vial® | 瓶盖内嵌干燥剂袖套，2年CFU下降率<10% |
| 诊断试纸 | Activ-Film® | 薄膜包装，正向线保留率提升15% |
| 散装/大包装 | Activ-Sachet® | 独立小袋放入大包装容器 |

### 按试验分期估算包装需求

| 试验分期 | 预估数量 | 包装需求级别 |
|---------|---------|------------|
| I期 | 20-100人 | 小批量 → Activ-Sachet® 即插即用 |
| II期 | 100-500人 | 中批量 → Activ-Vial® 或 Activ-Blister® |
| III期 | 500-5000人 | 大批量 → Activ-Blister® 或 3-Phase Activ-Polymer™ |
| IV期/上市后 | >5000人 | 量产 → 按剂型推荐，优先已获FDA批准的 Activ-Blister® |

## 数据来源

- CSP 技术参数和案例数据来自 `CSP.md`（项目根目录的 Aptar CSP 技术对比文档）
- FDA potency category 和 AI limit 来自 FDA 官方页面 Table 1
```

## Task 6: Create scenarios/nitrosamine/SKILL.md

Read the full content from the plan file: C:\app\pi_csp_agent\docs\superpowers\plans\2026-06-30-csp-lead-agent.md
Starting from the line `### Task 6: nitrosamine Scenario — SKILL.md` (around line 600+).

The SKILL.md file should contain:
- Frontmatter: name: nitrosamine, description (in Chinese)
- Three-phase pipeline instructions (FDA scraping, chinadrugtrials search, report generation)
- All in Simplified Chinese

## Commit

After creating all three files:
```bash
git add -A
git commit -m "feat: SKILL.md files for browser_executor and nitrosamine scenario + CSP recommendations"
```

## Global Constraints

- All SKILL.md and prompt instructions are in Simplified Chinese
- SKILL.md frontmatter must have `name` (lowercase, hyphens only) and `description` fields
