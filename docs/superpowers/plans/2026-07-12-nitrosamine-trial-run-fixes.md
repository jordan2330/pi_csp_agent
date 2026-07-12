# 试运行问题修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复试运行发现的4个问题：FDA分页数据不完整、API名称缺中文、中国临床试验网站无法触达、Docker镜像过大。

**Architecture:** 增强 browser.js（4个新action + 双模式连接 + waitUntil修复），新增中英对照翻译表，更新Docker配置移除本地浏览器改用独立browserless，更新SKILL.md指令适配所有变更。

**Tech Stack:** Node.js / Playwright / Docker / Pi Coding Agent

## Global Constraints

- 所有 SKILL.md 和 prompt 指令用简体中文
- browser.js 使用 script mode（JSON步骤文件），每次调用是独立进程
- 代码安全约束：所有 `wait` 必须设 `timeout`，禁止无限循环，`extract` 返回结构化JSON，单脚本≤120秒
- `loop` 的 `max_iterations` 必须 ≤ 50，`delay_ms` 建议 ≥ 1000
- `BROWSER_ENDPOINT` 环境变量：设了连远程 browserless，没设本地启动
- `navigate` 默认 `waitUntil: "domcontentloaded"`（不是 `networkidle`）

---

## File Structure

| 文件 | 职责 | 变更类型 |
|------|------|----------|
| `skills/browser_executor/scripts/browser.js` | Playwright浏览器自动化封装 | 重写：新增4个action + 双模式连接 + waitUntil + 跨平台路径 |
| `skills/browser_executor/SKILL.md` | browser-executor skill指令 | 修改：文档化新action + 约束更新 |
| `config/api_translations.json` | API中英对照查找表 | 新增：从参考文件解析 |
| `scenarios/nitrosamine/SKILL.md` | 亚硝胺场景指令 | 修改：FDA脚本 + 缓存schema + 临床试验脚本 + 回退策略 + 增量规则 |
| `Dockerfile` | Docker镜像构建 | 修改：移除chromium+fonts |
| `docker-compose.yml` | Docker编排 | 修改：添加BROWSER_ENDPOINT |
| `.env.example` | 环境变量模板 | 修改：添加BROWSER_ENDPOINT |
| `test/browser-test.html` | browser.js测试页面 | 新增 |
| `test/browser-test.json` | browser.js测试脚本 | 新增 |

---

### Task 1: browser.js 全面增强

**Files:**
- Modify: `skills/browser_executor/scripts/browser.js`（完整重写）
- Create: `test/browser-test.html`
- Create: `test/browser-test.json`

**Interfaces:**
- Produces: `executeStep(page, step, results)` — 递归执行单个步骤，支持loop子步骤调用自身
- Produces: `createBrowser()` — 双模式：`BROWSER_ENDPOINT`设了→`connectOverCDP()`，没设→`launch()`
- Produces: 4个新action：`select`, `evaluate`, `delay`, `loop`

- [ ] **Step 1: 重写 browser.js**

将 `skills/browser_executor/scripts/browser.js` 完整替换为以下内容：

```javascript
#!/usr/bin/env node

const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_FILE = path.join(os.tmpdir(), 'browser-state.json');
const DEFAULT_TIMEOUT = 30000;

const STEALTH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-infobars',
  '--window-size=1280,720',
  '--disable-dev-shm-usage',
];

const STEALTH_INIT_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
  window.chrome = { runtime: {} };
`;

function usage() {
  console.error(`Usage:
  node browser.js script <path-to-json-script>    Execute multi-step browser script
  node browser.js screenshot <url> <output-path>  Navigate to URL and save screenshot

Script JSON format:
  {
    "steps": [
      { "action": "navigate", "url": "https://..." },
      { "action": "type", "selector": "#input", "text": "query" },
      { "action": "click", "selector": "#button" },
      { "action": "wait", "selector": ".results", "timeout": 30000 },
      { "action": "select", "selector": "#page-size", "value": "-1" },
      { "action": "evaluate", "script": "document.title" },
      { "action": "delay", "ms": 2000 },
      { "action": "extract", "selector": ".table", "format": "json" },
      { "action": "screenshot", "path": "/tmp/debug.png" },
      {
        "action": "loop",
        "exit_when": { "selector": ".next.disabled", "condition": "exists" },
        "max_iterations": 20,
        "delay_ms": 1000,
        "steps": [
          { "action": "click", "selector": ".next" },
          { "action": "delay", "ms": 2000 },
          { "action": "wait", "selector": ".results", "timeout": 15000 },
          { "action": "extract", "selector": ".results", "format": "json" }
        ]
      }
    ]
  }

Output: JSON array of extraction results, in order of extract steps.
        Each result is either a string (text) or parsed table data (json).`);
  process.exit(1);
}

async function createBrowser() {
  let browser;

  if (process.env.BROWSER_ENDPOINT) {
    browser = await chromium.connectOverCDP(process.env.BROWSER_ENDPOINT);
  } else {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: STEALTH_ARGS,
    });
  }

  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  });

  await context.addInitScript(STEALTH_INIT_SCRIPT);

  if (fs.existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (state.cookies) await context.addCookies(state.cookies);
    } catch (e) {
      // Ignore corrupted state file
    }
  }

  return { browser, context };
}

async function executeStep(page, step, results) {
  switch (step.action) {
    case 'navigate':
      await page.goto(step.url, {
        waitUntil: step.waitUntil || 'domcontentloaded',
        timeout: step.timeout || DEFAULT_TIMEOUT,
      });
      break;

    case 'type':
      await page.fill(step.selector, step.text, { timeout: step.timeout || DEFAULT_TIMEOUT });
      break;

    case 'click':
      await page.click(step.selector, { timeout: step.timeout || DEFAULT_TIMEOUT });
      break;

    case 'wait':
      await page.waitForSelector(step.selector, { timeout: step.timeout || DEFAULT_TIMEOUT });
      break;

    case 'select':
      await page.selectOption(step.selector, step.value, { timeout: step.timeout || DEFAULT_TIMEOUT });
      break;

    case 'evaluate': {
      const result = await page.evaluate(step.script);
      results.push(result);
      break;
    }

    case 'delay':
      await page.waitForTimeout(step.ms);
      break;

    case 'extract': {
      const format = step.format || 'text';
      if (format === 'json') {
        const data = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const tables = el.querySelectorAll('table');
          if (tables.length > 0) {
            return Array.from(tables).map(table =>
              Array.from(table.querySelectorAll('tr')).map(row =>
                Array.from(row.querySelectorAll('td,th')).map(cell => cell.textContent.trim())
              )
            );
          }
          const items = el.querySelectorAll('li, tr, .item');
          if (items.length > 0) {
            return Array.from(items).map(item => item.textContent.trim());
          }
          return el.textContent.trim();
        }, step.selector);
        results.push(data);
      } else {
        const text = await page.textContent(step.selector, { timeout: step.timeout || DEFAULT_TIMEOUT });
        results.push(text ? text.trim() : null);
      }
      break;
    }

    case 'screenshot':
      await page.screenshot({ path: step.path, fullPage: step.fullPage || false });
      results.push({ screenshot: step.path });
      break;

    case 'loop': {
      const maxIterations = Math.min(step.max_iterations || 20, 50);
      const delayMs = step.delay_ms || 0;
      const exitWhen = step.exit_when;

      for (let i = 0; i < maxIterations; i++) {
        if (exitWhen) {
          const element = await page.$(exitWhen.selector);
          let shouldExit = false;
          if (exitWhen.condition === 'exists') {
            shouldExit = !!element;
          } else if (exitWhen.condition === 'missing') {
            shouldExit = !element;
          }
          if (shouldExit) break;
        }

        for (const subStep of step.steps) {
          await executeStep(page, subStep, results);
        }

        if (delayMs > 0) {
          await page.waitForTimeout(delayMs);
        }
      }
      break;
    }

    default:
      console.error(`Unknown action: ${step.action}`);
      process.exitCode = 1;
      return;
  }
}

async function runScript(scriptPath) {
  const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  const steps = script.steps || [];

  const { browser, context } = await createBrowser();
  const page = await context.newPage();
  const results = [];

  try {
    for (const step of steps) {
      await executeStep(page, step, results);
    }

    const cookies = await context.cookies();
    fs.writeFileSync(STATE_FILE, JSON.stringify({ cookies }));

    console.log(JSON.stringify(results, null, 2));

  } catch (error) {
    console.error(JSON.stringify({ error: error.message, stack: error.stack }));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

async function runScreenshot(url, outputPath) {
  const { browser, context } = await createBrowser();
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT });
    await page.screenshot({ path: outputPath, fullPage: true });
    console.log(JSON.stringify({ success: true, path: outputPath }));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

const [action, ...args] = process.argv.slice(2);

if (action === 'script') {
  if (!args[0]) usage();
  runScript(args[0]);
} else if (action === 'screenshot') {
  if (!args[0] || !args[1]) usage();
  runScreenshot(args[0], args[1]);
} else {
  usage();
}
```

- [ ] **Step 2: 创建测试HTML页面**

创建 `test/browser-test.html`：

```html
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Browser Test Page</title></head>
<body>
  <h1 id="title">Test Page</h1>

  <select id="page-size">
    <option value="10">10</option>
    <option value="25">25</option>
    <option value="-1">All</option>
  </select>

  <table id="data-table">
    <thead><tr><th>Name</th><th>Value</th></tr></thead>
    <tbody>
      <tr><td>Row 1</td><td>100</td></tr>
      <tr><td>Row 2</td><td>200</td></tr>
      <tr><td>Row 3</td><td>300</td></tr>
    </tbody>
  </table>

  <div id="page-nav">
    <span class="page current">1</span>
    <a class="page next" href="#" onclick="return false;">2</a>
    <a class="page next disabled" style="display:none;">3</a>
  </div>

  <p id="js-value" data-test="hello"></p>
  <script>document.getElementById('js-value').textContent = 'set-by-js';</script>
</body>
</html>
```

- [ ] **Step 3: 创建测试脚本JSON**

创建 `test/browser-test.json`：

```json
{
  "steps": [
    { "action": "navigate", "url": "file://__HTML_PATH__", "timeout": 10000 },
    { "action": "wait", "selector": "#data-table", "timeout": 5000 },
    { "action": "evaluate", "script": "document.getElementById('js-value').textContent" },
    { "action": "select", "selector": "#page-size", "value": "-1" },
    { "action": "delay", "ms": 500 },
    { "action": "extract", "selector": "#data-table", "format": "json" },
    {
      "action": "loop",
      "exit_when": { "selector": ".next.disabled", "condition": "exists" },
      "max_iterations": 5,
      "delay_ms": 100,
      "steps": [
        { "action": "evaluate", "script": "document.querySelector('.next.disabled') ? 'disabled-found' : 'not-disabled'" },
        { "action": "click", "selector": ".next.disabled", "timeout": 1000 }
      ]
    }
  ]
}
```

注意：`__HTML_PATH__` 需替换为测试HTML文件的绝对路径。loop会在第一次迭代开始时检查 `.next.disabled` 是否存在——该元素 `style="display:none"`，但 `page.$()` 仍能找到它（display:none不影响DOM存在性），所以 loop 会在第一次迭代开始时退出。测试中 loop 不执行任何子步骤，results中不会有 loop 子步骤的输出。

- [ ] **Step 4: 提交**

```bash
git add skills/browser_executor/scripts/browser.js test/browser-test.html test/browser-test.json
git commit -m "feat: enhance browser.js with select/evaluate/loop/delay actions, dual-mode connection, domcontentloaded default"
```

---

### Task 2: config/api_translations.json — 中英对照表

**Files:**
- Create: `config/api_translations.json`

**Interfaces:**
- Produces: `config/api_translations.json` — `{ "EnglishName": "中文名", ... }` 查找表
- Consumes: `20260616_6月上新亚硝胺药物分析杂质.md` 参考文件（行63-269的API对照对）

- [ ] **Step 1: 解析参考文件，生成对照表**

参考文件格式（行63起）：`氨溴索 Ambroxol` — 中文名 + 空格 + 英文名。

创建 `config/api_translations.json`：

```json
{
  "Ambroxol": "氨溴索",
  "Atenolol": "阿替洛尔",
  "Atomoxetine": "阿托莫西汀",
  "Apixaban": "阿哌沙班",
  "Abemaciclib": "阿贝西利",
  "Acebutolol": "醋丁洛尔",
  "Apalutamide": "阿帕他胺",
  "Benazepril": "贝那普利",
  "Biotin": "生物素",
  "Bisoprolol": "比索洛尔",
  "Brinzolamide": "布林唑胺",
  "Brompheniramine": "溴苯那敏",
  "Bupropion": "安非他酮",
  "Bupivacaine": "布比卡因",
  "Carvedilol": "卡维地洛",
  "Chloropyramine": "氯吡拉敏",
  "Chlorpheniramine": "氯苯那敏",
  "Cinacalcet": "西那卡塞",
  "Clomipramine": "氯米帕明",
  "Cyclobenzaprine": "环苯扎林",
  "Chlorpromazine": "氯丙嗪",
  "Cidoxepin": "西多塞平",
  "Carbinoxamine": "卡比沙明",
  "Citalopram": "西酞普兰",
  "Clarithromycin": "克拉霉素",
  "Cabergoline": "卡麦角林",
  "Dabigatran Etexilate": "达比加群酯",
  "Desipramine": "去甲替林",
  "Diclofenac": "双氯芬酸",
  "Diphenhydramine": "苯海拉明",
  "Dipivefrin": "地匹福林",
  "Dorzolamide": "多佐胺",
  "Doxylamine": "多西拉敏",
  "Duloxetine": "度洛西汀",
  "Dexchlorpheniramine": "右氯苯那敏",
  "Desloratadine": "地氯雷他定",
  "Doxepin": "多塞平",
  "Dasatinib": "达沙替尼",
  "Edoxaban": "艾多沙班",
  "Ephedrine": "麻黄碱",
  "Epinephrine": "肾上腺素",
  "Escitalopram": "艾司西酞普兰",
  "Enalapril": "依那普利",
  "Esmolol": "艾司洛尔",
  "Fenfluramine": "芬氟拉明",
  "Fluoxetine": "氟西汀",
  "Folic Acid": "叶酸",
  "Gatifloxacin": "加替沙星",
  "Hydrochlorothiazide": "氢氯噻嗪",
  "Labetalol": "拉贝洛尔",
  "Landiolol": "兰地洛尔",
  "Levofloxacin": "左氧氟沙星",
  "Lisinopril": "赖诺普利",
  "Lapatinib": "拉帕替尼",
  "Lorcaserin": "氯卡色林",
  "Mefenamic Acid": "甲芬那酸",
  "Metoprolol": "美托洛尔",
  "Moxifloxacin": "莫西沙星",
  "Mitoxantrone": "米托蒽醌",
  "Methylene Blue": "亚甲基蓝",
  "Mifepristone": "米非司酮",
  "Nebivolol": "奈必洛尔",
  "Nortriptyline": "去甲替林",
  "Nizatidine": "尼扎替丁",
  "Nadolol": "纳多洛尔",
  "Norfloxacin": "诺氟沙星",
  "Paroxetine": "帕罗西汀",
  "Perindopril": "培哚普利",
  "Phenylephrine": "去氧肾上腺素",
  "Pramipexole": "普拉克索",
  "Propranolol": "普萘洛尔",
  "Propafenone": "普罗帕酮",
  "Pyrilamine": "美吡拉敏",
  "Pheniramine": "非尼拉敏",
  "Promethazine": "异丙嗪",
  "Quetiapine": "喹硫平",
  "Quinapril": "喹那普利",
  "Rasagiline": "雷沙吉兰",
  "Rivastigmine": "利斯的明",
  "Ranitidine": "雷尼替丁",
  "Rivaroxaban": "利伐沙班",
  "Rizatriptan": "利扎曲普坦",
  "Ranolazine": "雷诺嗪",
  "Safinamide": "沙非酰胺",
  "Salmeterol": "沙美特罗",
  "Sertraline": "舍曲林",
  "Sitagliptin": "西格列汀",
  "Sotalol": "索他洛尔",
  "Sumatriptan": "舒马普坦",
  "Tamsulosin": "坦索罗辛",
  "Tetracaine": "丁卡因",
  "Tofacitinib": "托法替布",
  "Trimetazidine": "曲美他嗪",
  "Tamoxifen": "他莫昔芬",
  "Trimethobenzamide": "曲美苄胺",
  "Thonzylamine": "松齐拉敏",
  "Terazosin": "特拉唑嗪",
  "Valacyclovir": "伐昔洛韦",
  "Varenicline": "伐尼克兰",
  "Vilanterol": "维兰特罗",
  "Vonoprazan": "伏诺拉生",
  "Venlafaxine": "文拉法辛",
  "Valsartan": "缬沙坦",
  "Zolmitriptan": "佐米曲普坦"
}
```

- [ ] **Step 2: 验证对照表条目数**

Run: `node -e "const d=require('./config/api_translations.json'); console.log('count:', Object.keys(d).length)"`
Expected: `count: 96`（参考文件中有约96个API对照对）

- [ ] **Step 3: 提交**

```bash
git add config/api_translations.json
git commit -m "feat: add API bilingual translation lookup table from USP reference"
```

---

### Task 3: Docker 瘦身

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `.env.example`

- [ ] **Step 1: 更新 Dockerfile**

将 `Dockerfile` 完整替换为：

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

- [ ] **Step 2: 更新 docker-compose.yml**

将 `docker-compose.yml` 完整替换为：

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

- [ ] **Step 3: 更新 .env.example**

将 `.env.example` 完整替换为：

```
DASHSCOPE_API_KEY=
BROWSER_ENDPOINT=ws://ssuzaip38.aptargroup.loc:3000/?token=PW8rJqSTzd
```

- [ ] **Step 4: 提交**

```bash
git add Dockerfile docker-compose.yml .env.example
git commit -m "feat: slim Docker image — remove chromium/fonts, add BROWSER_ENDPOINT for remote browserless"
```

---

### Task 4: skills/browser_executor/SKILL.md — 文档化新 action

**Files:**
- Modify: `skills/browser_executor/SKILL.md`

- [ ] **Step 1: 更新 SKILL.md**

将 `skills/browser_executor/SKILL.md` 完整替换为：

```markdown
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
| `navigate` | `url`, `timeout`(可选), `waitUntil`(可选, 默认`domcontentloaded`) | 导航到指定URL。**注意：默认使用`domcontentloaded`而非`networkidle`**，因为部分网站（如chinadrugtrials）有持久连接，`networkidle`永不触发。可在步骤中用`"waitUntil": "networkidle"`覆盖 |
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
```

- [ ] **Step 2: 提交**

```bash
git add skills/browser_executor/SKILL.md
git commit -m "docs: update browser-executor SKILL.md with new actions and dual-mode connection"
```

---

### Task 5: scenarios/nitrosamine/SKILL.md — 更新场景指令

**Files:**
- Modify: `scenarios/nitrosamine/SKILL.md`

- [ ] **Step 1: 更新 SKILL.md**

将 `scenarios/nitrosamine/SKILL.md` 完整替换为：

```markdown
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

1. **重要**：你需要先访问一次搜索页面，截图分析实际的 HTML 结构，然后调整下列选择器。选择器可能因网站更新而变化。

2. 创建 browser script JSON 文件（如 `/tmp/trial-search.json`）：

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
      "text": "API中文名"
    },
    {
      "action": "click",
      "selector": "input[type='submit'], button[type='submit'], .search-btn"
    },
    {
      "action": "delay",
      "ms": 2000
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
    },
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

3. 翻页说明：
   - 首页 `extract` 在 `loop` 外部
   - `loop` 在每次迭代开始前检查 `exit_when`（下一页按钮是否 disabled）
   - 未 disabled → 执行子步骤：点击下一页 → 延时2秒 → 等待新结果 → 提取
   - 已 disabled → 退出循环（首页已提取，不会漏数据）

4. 对每个 API 执行搜索脚本，提取以下字段：
   - 申请人/申办者
   - 试验名称/药物名称
   - 试验状态（如：进行中、已完成、已招募）
   - 适应症
   - 试验分期（I期、II期、III期、IV期）
   - 主要研究者
   - 试验机构
   - 登记日期

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
```

- [ ] **Step 2: 提交**

```bash
git add scenarios/nitrosamine/SKILL.md
git commit -m "feat: update nitrosamine SKILL.md — FDA select(All), name_cn, loop pagination, ClinicalTrials.gov fallback, 3-year incremental"
```

---

## Self-Review

**1. Spec coverage:**
- Issue 1 (FDA pagination): Task 1 (select action) + Task 5 (FDA script template with select("All")) ✓
- Issue 2 (bilingual names): Task 2 (api_translations.json) + Task 5 (cache schema with name_cn, translation flow) ✓
- Issue 3 (clinical trial search): Task 1 (dual-mode, loop, delay, domcontentloaded) + Task 4 (SKILL.md docs) + Task 5 (chinadrugtrials script + ClinicalTrials.gov fallback + incremental) ✓
- Issue 4 (Docker slimming): Task 3 (Dockerfile + compose + env) ✓

**2. Placeholder scan:** No TBD/TODO. All code is complete. ✓

**3. Type consistency:** `executeStep` used consistently across all tasks. `name_cn` field name consistent in cache schema and SKILL.md. `BROWSER_ENDPOINT` env var consistent across Dockerfile, compose, .env.example, browser.js, SKILL.md. ✓
