---
name: browser-executor
description: 真实浏览器自动化工具。使用 Playwright 在真实 Chromium 浏览器中导航、输入、点击、等待和提取网页数据。用于需要 JavaScript 渲染的网站（如中国药物临床试验登记平台）。当需要与网页进行交互式操作时使用此 skill。
---

# Browser Executor

通用浏览器自动化工具，基于 Playwright。用于在真实浏览器中执行多步骤网页操作。

## 核心概念

每次调用 `browser.js` 是一个独立进程。**页面状态无法跨调用保持**。因此使用 **script 模式**：将所有操作步骤写入一个 JSON 文件，一次性执行。

## 浏览器连接模式

连接端点由 `scripts/browser-connect.js` 统一解析，优先级：

1. **`BROWSER_ENDPOINT` 环境变量**（显式指定，`http://` 或 `ws://` 均可）—— 必须成功，失败即报错
2. **默认本机真浏览器端点 `http://127.0.0.1:9223`**（生产模式）：Windows 侧专用 profile Chrome，由 `scripts/launch-chrome.sh` 启动；端点已在跑则直接连，未启动会自动拉起 Chrome 后重连
3. **`CDP_ALLOW_LOCAL_LAUNCH=1` 时**兜底 `chromium.launch()`（仅开发调试用）

**为什么必须是真浏览器**：CDT（chinadrugtrials.org.cn）已启用瑞数动态安全（JS 质询 + 浏览器指纹检测），headless/自动化浏览器会被质询拦截；真实 Chrome 才能正常通过。

**前置条件**：WSL 需 mirrored 网络模式（`.wslconfig` → `networkingMode=mirrored`），否则访问不到 Windows 的 `127.0.0.1`。

**真浏览器模式（`isRealBrowser=true`）的行为差异**：
- 不覆盖 `userAgent` / `viewport`（要么用真实值，覆盖反而造成 UA 与客户端提示不一致）
- 不注入伪造指纹（详见下文反检测机制）
- 仅在本地兜底 launch 时才应用 stealth 伪装

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

- 脚本路径相对于工作目录（仓库根目录即工作目录）
- 截图路径建议放 `/tmp` 或仓库内 `output/` 下
- Cookie 状态自动保存在临时目录的 `browser-state.json`，跨调用保持会话

## 错误处理

- 任何步骤失败，整个脚本终止，错误信息输出到 stderr
- 建议 Pi 在遇到错误时截图调试，然后调整选择器重试

## 反检测机制

**真浏览器模式（默认，生产）**：
- **不注入任何伪造指纹**：真 Chrome 本来就没有 `navigator.webdriver` 等自动化痕迹，而伪造值（如 `plugins=[1,2,3,4,5]`）本身是瑞数可识别的特征
- 只保留 `locale: zh-CN` 与 `Accept-Language`（保证中文站点正常返回）
- 瑞数质询由真实浏览器引擎自动通过（已实测，无需人工兵底）

**本地兵底 launch 模式（仅调试）**：
- 隐藏 `navigator.webdriver`、注入 `plugins`/`languages`/`window.chrome`、禁用 `AutomationControlled`、伪装 UA
- 注意：该模式**不建议**用于 CDT 生产采集，很可能被瑞数拦截

如页面出现验证码，截图保存并向用户报告即可（真浏览器模式下用户可在 Chrome 窗口手动处理）。

## 代码安全约束

当你在 SKILL.md 中编写 browser script JSON 时，必须遵守：
- **所有 `wait` 步骤必须设置 `timeout`**，禁止不设超时的等待
- **禁止使用无限循环**，`loop` 的 `max_iterations` 必须 ≤ 50，`delay_ms` 建议 ≥ 1000
- **每个 `extract` 步骤的输出必须是结构化 JSON**，禁止返回无结构的模糊字符串
- **单个脚本的执行时间不应超过 120 秒**，超时由 Playwright 自动终止
- **翻页时首页 extract 放在 loop 外部**，loop 内先点击下一页再 extract
