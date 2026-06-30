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
