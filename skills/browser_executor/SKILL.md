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
| `extract` | `selector`, `format`("json"或"text") | 提取数据。json格式会解析表格结构（二维/三维数组） |
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
