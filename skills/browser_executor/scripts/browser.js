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
