# CSP Lead Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Docker-containerized Pi Agent that scrapes FDA nitrosamine impurity data, searches chinadrugtrials.org.cn for matching clinical trials, and generates a CSP product lead report in Markdown.

**Architecture:** Pi Coding Agent with two skills (generic browser_executor + nitrosamine scenario), one prompt template (lead-scan entry point), and Qwen LLM via DashScope. browser.js wraps Playwright in a "script mode" that executes multi-step browser interactions in a single process invocation. Docker provides isolation and scheduled execution.

**Tech Stack:** Node.js 24, Pi Coding Agent, Playwright, Chromium, Docker, Qwen (DashScope OpenAI-compatible API)

## Global Constraints

- LLM provider: Qwen via DashScope (`https://dashscope.aliyuncs.com/compatible-mode/v1`), not Anthropic
- API key env var: `DASHSCOPE_API_KEY`
- Pi's native `thinkingFormat: "qwen"` compat flag must be set in models.json
- Chromium binary at `/usr/bin/chromium` (system-installed, not Playwright-bundled)
- `NODE_PATH=/usr/lib/node_modules` required so browser.js can `require('playwright')`
- All content instructions in SKILL.md files are in Simplified Chinese
- No git repo exists yet — Task 1 initializes it

---

## File Structure

| File | Responsibility |
|------|---------------|
| `.gitignore` | Ignore .env, output/runs/, node_modules/ |
| `.env.example` | Template for DASHSCOPE_API_KEY |
| `Dockerfile` | Docker image: Node 24 + Pi + Playwright + Chromium |
| `docker-compose.yml` | Container orchestration with volume mounts |
| `AGENTS.md` | Pi project instructions loaded at startup |
| `.pi/settings.json` | Pi skills/prompts path mapping |
| `config/models.json` | Qwen provider config for Pi |
| `skills/browser_executor/SKILL.md` | Browser tool skill definition |
| `skills/browser_executor/scripts/browser.js` | Playwright CLI wrapper (script mode) |
| `skills/browser_executor/scripts/package.json` | Node.js deps for browser.js |
| `scenarios/nitrosamine/SKILL.md` | Nitrosamine scenario pipeline instructions |
| `scenarios/nitrosamine/references/csp-recommendations.md` | CSP product recommendation rules by potency category |
| `prompts/lead-scan.md` | Entry prompt template: `/lead-scan <scenario>` |
| `output/.gitkeep` | Ensure output directory exists in git |

---

### Task 1: Project Scaffolding & Docker

**Files:**
- Create: `.gitignore`
- Create: `.env.example`
- Create: `output/.gitkeep`
- Create: `Dockerfile`
- Create: `docker-compose.yml`

**Interfaces:**
- Produces: A Docker image named `pi-csp-agent` that runs Pi with Playwright support

- [ ] **Step 1: Create .gitignore**

```
.env
output/runs/
node_modules/
*.log
```

- [ ] **Step 2: Create .env.example**

```
DASHSCOPE_API_KEY=
```

- [ ] **Step 3: Create output/.gitkeep**

Empty file to ensure the output directory exists in git.

- [ ] **Step 4: Create Dockerfile**

```dockerfile
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       bash ca-certificates git ripgrep \
       chromium fonts-wqy-zenhei \
  && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=true
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_PATH=/usr/lib/node_modules

RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent
RUN npm install -g playwright

WORKDIR /workspace
ENTRYPOINT ["pi"]
```

- [ ] **Step 5: Create docker-compose.yml**

```yaml
services:
  csp-agent:
    build: .
    environment:
      - DASHSCOPE_API_KEY=${DASHSCOPE_API_KEY}
    volumes:
      - .:/workspace
      - pi-agent-home:/root/.pi/agent
    stdin_open: true
    tty: true

volumes:
  pi-agent-home:
```

- [ ] **Step 6: Initialize git and verify Docker build**

```bash
git init
git add -A
git commit -m "chore: project scaffolding and Docker setup"
```

Verify Docker image builds:
```bash
docker build -t pi-csp-agent .
```
Expected: Build succeeds with no errors.

---

### Task 2: Pi Configuration (Qwen + Settings + AGENTS.md)

**Files:**
- Create: `.pi/settings.json`
- Create: `config/models.json`
- Create: `AGENTS.md`

**Interfaces:**
- Consumes: `DASHSCOPE_API_KEY` environment variable
- Produces: Pi configuration that loads Qwen models and maps skills/prompts paths

- [ ] **Step 1: Create .pi/settings.json**

```json
{
  "skills": ["skills/", "scenarios/"],
  "prompts": ["prompts/"]
}
```

- [ ] **Step 2: Create config/models.json**

```json
{
  "providers": {
    "qwen": {
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "api": "openai-completions",
      "apiKey": "$DASHSCOPE_API_KEY",
      "compat": {
        "thinkingFormat": "qwen"
      },
      "models": [
        {
          "id": "qwen-max",
          "name": "Qwen Max",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 32768,
          "maxTokens": 8192,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        },
        {
          "id": "qwen-plus",
          "name": "Qwen Plus",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 131072,
          "maxTokens": 8192,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

- [ ] **Step 3: Create AGENTS.md**

```markdown
# AGENTS.md

## Project Overview

This is a Pi Coding Agent project for CSP (Aptar active packaging) sales lead discovery. The agent scrapes regulatory and clinical trial data, matches customer profiles, and generates Markdown lead reports.

## LLM Configuration

- Provider: Qwen (通义千问) via DashScope OpenAI-compatible API
- Models: `qwen-max` for complex reasoning (report generation), `qwen-plus` for routine tasks
- Config: `config/models.json` → mounted to `/root/.pi/agent/models.json` in Docker
- API key: `DASHSCOPE_API_KEY` environment variable

## Project Structure

- `skills/browser_executor/` — Generic Playwright browser automation tool (shared across all scenarios)
- `scenarios/` — Business scenario skills (nitrosamine, probiotics, IVD, etc.)
- `prompts/` — Pi prompt templates (entry points like `/lead-scan`)
- `config/` — Cached data and model configuration
- `output/` — Generated reports and run snapshots

## Key Conventions

- All SKILL.md and prompt instructions are written in Simplified Chinese
- browser.js uses "script mode" (JSON step file) for multi-step browser interactions — each invocation is a separate process, so page state cannot persist across calls
- Incremental detection: each run saves a snapshot to `output/runs/YYYY-MM-DD.json`; next run compares to find new leads
- FDA data is auto-refreshed each run (page updated quarterly by FDA)
```

- [ ] **Step 4: Copy models.json into Pi agent home and verify**

The `config/models.json` needs to be available at `/root/.pi/agent/models.json` inside the container. Update `docker-compose.yml` to mount it:

```yaml
    volumes:
      - .:/workspace
      - pi-agent-home:/root/.pi/agent
      - ./config/models.json:/root/.pi/agent/models.json:ro
```

- [ ] **Step 5: Verify Pi loads Qwen models**

```bash
cp .env.example .env
# Edit .env and add your DASHSCOPE_API_KEY
docker compose run --rm csp-agent --list-models
```
Expected: Output includes `qwen-max` and `qwen-plus` in the model list.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: Pi configuration with Qwen provider and project instructions"
```

---

### Task 3: browser_executor Skill — browser.js

**Files:**
- Create: `skills/browser_executor/scripts/package.json`
- Create: `skills/browser_executor/scripts/browser.js`

**Interfaces:**
- Consumes: Playwright (globally installed), `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` env var
- Produces: A CLI tool that executes multi-step browser scripts and returns extracted data as JSON

**Design note:** Each `browser.js` invocation is a separate Node.js process. Page state (URL, DOM) cannot persist across separate calls. Therefore, `browser.js` uses a **script mode**: it accepts a JSON file describing multiple steps (navigate, type, click, wait, extract), executes them all in one browser session, and returns the results of all `extract` steps.

- [ ] **Step 1: Create package.json**

```json
{
  "name": "browser-executor",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "playwright": "^1.40.0"
  }
}
```

Note: Playwright is installed globally in Docker, but this package.json documents the dependency. No `npm install` needed in the skill directory since `NODE_PATH=/usr/lib/node_modules` makes the global install resolvable.

- [ ] **Step 2: Create browser.js**

```javascript
#!/usr/bin/env node

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const STATE_FILE = '/tmp/browser-state.json';
const DEFAULT_TIMEOUT = 30000;

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
      { "action": "extract", "selector": ".table", "format": "json" },
      { "action": "extract", "selector": ".text", "format": "text" },
      { "action": "screenshot", "path": "/tmp/debug.png" }
    ]
  }

Output: JSON array of extraction results, in order of extract steps.
        Each result is either a string (text) or parsed table data (json).`);
  process.exit(1);
}

async function runScript(scriptPath) {
  const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  const steps = script.steps || [];

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  // Restore cookies if state file exists
  if (fs.existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (state.cookies) await context.addCookies(state.cookies);
    } catch (e) {
      // Ignore corrupted state file
    }
  }

  const page = await context.newPage();
  const results = [];

  try {
    for (const step of steps) {
      switch (step.action) {
        case 'navigate':
          await page.goto(step.url, { waitUntil: 'networkidle', timeout: step.timeout || DEFAULT_TIMEOUT });
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
              // Return structured list items if no table
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

        default:
          console.error(`Unknown action: ${step.action}`);
          process.exit(1);
      }
    }

    // Save cookies
    const cookies = await context.cookies();
    fs.writeFileSync(STATE_FILE, JSON.stringify({ cookies }));

    // Output results as JSON
    console.log(JSON.stringify(results, null, 2));

  } catch (error) {
    console.error(JSON.stringify({ error: error.message, stack: error.stack }));
    process.exit(1);
  } finally {
    await browser.close();
  }
}

async function runScreenshot(url, outputPath) {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage({
    locale: 'zh-CN',
    viewport: { width: 1280, height: 720 },
  });

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: DEFAULT_TIMEOUT });
    await page.screenshot({ path: outputPath, fullPage: true });
    console.log(JSON.stringify({ success: true, path: outputPath }));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message }));
    process.exit(1);
  } finally {
    await browser.close();
  }
}

// Main
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

- [ ] **Step 3: Create a test script to verify browser.js**

Create a temporary test file `scripts/test-browser.json`:

```json
{
  "steps": [
    { "action": "navigate", "url": "https://example.com" },
    { "action": "wait", "selector": "h1" },
    { "action": "extract", "selector": "h1", "format": "text" }
  ]
}
```

Run inside Docker:
```bash
docker compose run --rm csp-agent bash -c "node skills/browser_executor/scripts/browser.js script skills/browser_executor/scripts/test-browser.json"
```
Expected: JSON output containing `"Example Domains"` (the h1 text from example.com).

- [ ] **Step 4: Clean up test file and commit**

```bash
rm skills/browser_executor/scripts/test-browser.json
git add -A
git commit -m "feat: browser_executor skill with Playwright script mode"
```

---

### Task 4: browser_executor Skill — SKILL.md

**Files:**
- Create: `skills/browser_executor/SKILL.md`

**Interfaces:**
- Consumes: `skills/browser_executor/scripts/browser.js` (from Task 3)
- Produces: Pi skill definition that teaches the LLM how to use browser.js

- [ ] **Step 1: Create SKILL.md**

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

- [ ] **Step 2: Verify Pi discovers the skill**

```bash
docker compose run --rm csp-agent bash -c "pi --list-skills 2>/dev/null || echo 'list-skills not available, verify manually'"
```

Or start Pi interactively and check:
```bash
docker compose run --rm csp-agent
# Inside Pi TUI, type:
/skill:browser-executor
```
Expected: Pi loads the browser-executor skill content.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: browser_executor SKILL.md with usage instructions"
```

---

### Task 5: nitrosamine Scenario — csp-recommendations.md

**Files:**
- Create: `scenarios/nitrosamine/references/csp-recommendations.md`

**Interfaces:**
- Consumes: FDA potency category data
- Produces: CSP product recommendation rules for the report generator

- [ ] **Step 1: Create csp-recommendations.md**

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

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: CSP product recommendation rules by potency category"
```

---

### Task 6: nitrosamine Scenario — SKILL.md

**Files:**
- Create: `scenarios/nitrosamine/SKILL.md`

**Interfaces:**
- Consumes: `skills/browser_executor/` (from Tasks 3-4), `references/csp-recommendations.md` (from Task 5)
- Produces: Complete pipeline instructions for the nitrosamine lead discovery scenario

- [ ] **Step 1: Create SKILL.md**

````markdown
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

5. 构建结构化数据并写入 `config/fda_nitrosamines.json`：

```json
{
  "last_updated": "2026-06-30",
  "fda_page_version": "2026-03-19",
  "nitrosamines": [
    {
      "nitrosamine_name": "N-nitroso-atenolol",
      "source_api": "Atenolol",
      "potency_category": 4,
      "ai_limit": "1500 ng/day"
    }
  ],
  "unique_apis": ["Atenolol", "Metoprolol", ...]
}
```

### 错误处理

- 如果 FDA 页面无法访问，重试 3 次
- 仍失败则使用 `config/fda_nitrosamines.json` 中的缓存数据，并在报告中注明使用了缓存

---

## Phase 2: 中国临床试验搜索

### 目标

对每个 API 在 chinadrugtrials.org.cn 搜索相关临床试验，提取申请人信息。

### 搜索策略

对 `fda_nitrosamines.json` 中的每个 API：
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

### 报告要求

- 按风险等级从高到低排列
- 新增商机在最前面单独列出
- 每个API下的企业按试验分期从高到低排列（III期 > II期 > I期）
- 如果某API无中国临床试验，不在报告中列出
````

- [ ] **Step 2: Verify Pi discovers the scenario skill**

```bash
docker compose run --rm csp-agent
# Inside Pi TUI:
/skill:nitrosamine
```
Expected: Pi loads the nitrosamine scenario skill content.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: nitrosamine scenario skill with 3-phase pipeline instructions"
```

---

### Task 7: lead-scan Prompt Template & End-to-End Verification

**Files:**
- Create: `prompts/lead-scan.md`

**Interfaces:**
- Consumes: All skills from Tasks 3-6
- Produces: Entry point that Pi users invoke with `/lead-scan <scenario>`

- [ ] **Step 1: Create prompts/lead-scan.md**

```markdown
---
description: 执行CSP商机发掘扫描
argument-hint: "<scenario>"
---
执行 $1 场景的商机发掘扫描。

1. 使用 /skill:$1 加载场景 skill，按其 SKILL.md 指令执行完整 pipeline
2. 首先确保 browser-executor skill 已就绪（如未加载则先 /skill:browser-executor）
3. 按场景 SKILL.md 的三个阶段依次执行：
   - Phase 1: FDA 数据采集与缓存
   - Phase 2: 中国临床试验搜索
   - Phase 3: 报告生成
4. 如遇到网页加载失败或验证码：
   - 交互模式：暂停并向用户说明情况，等待指示
   - 自动模式（pi -p）：截图保存，记录错误，继续下一个API
5. 完成后输出 output/CSP_Leads_Report.md 的路径，并简要总结新增商机数量
```

- [ ] **Step 2: Verify Pi discovers the prompt template**

```bash
docker compose run --rm csp-agent
# Inside Pi TUI, type / and check autocomplete shows:
# /lead-scan   <scenario>   — 执行CSP商机发掘扫描
```
Expected: `/lead-scan` appears in the prompt template autocomplete.

- [ ] **Step 3: End-to-end smoke test (interactive)**

```bash
docker compose run --rm csp-agent
# Inside Pi TUI:
/lead-scan nitrosamine
```

Watch the agent execute the pipeline. Key checkpoints:
- FDA page loads and table data is extracted
- `config/fda_nitrosamines.json` is written with API list
- chinadrugtrials.org.cn loads and search works for at least one API
- `output/CSP_Leads_Report.md` is generated

If chinadrugtrials selectors need adjustment, steer the agent interactively (e.g., "先截图看看搜索页面的HTML结构").

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: lead-scan prompt template and complete pipeline"
```

---

## Post-Implementation Notes

### Selector Maintenance

chinadrugtrials.org.cn 和 FDA 页面的 HTML 结构可能随时间变化。如果 `browser.js` 的 extract 步骤返回 null 或空数据：

1. 用 `screenshot` action 截图当前页面
2. 用 Pi 的 `read` 工具检查截图
3. 用浏览器开发者工具或 `page.evaluate` 检查实际 DOM 结构
4. 更新 SKILL.md 中的 CSS 选择器

### Adding New Scenarios

To add a new scenario (e.g., probiotics):

1. Create `scenarios/probiotics/SKILL.md` with scenario-specific instructions
2. Create `scenarios/probiotics/references/` with reference docs
3. Run `/lead-scan probiotics`

No changes needed to `browser_executor` skill or `lead-scan.md` prompt.
