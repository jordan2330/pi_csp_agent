# Task 3: browser_executor Skill — browser.js

**Files:**
- Create: `skills/browser_executor/scripts/package.json`
- Create: `skills/browser_executor/scripts/browser.js`

**Interfaces:**
- Consumes: Playwright (globally installed in Docker), `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` env var
- Produces: A CLI tool that executes multi-step browser scripts and returns extracted data as JSON

## Design note

Each `browser.js` invocation is a separate Node.js process. Page state (URL, DOM) cannot persist across separate calls. Therefore, `browser.js` uses a **script mode**: it accepts a JSON file describing multiple steps (navigate, type, click, wait, extract), executes them all in one browser session, and returns the results of all `extract` steps.

## Step 1: Create package.json

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

Note: Playwright is installed globally in Docker, but this package.json documents the dependency. No `npm install` needed in the skill directory since `NODE_PATH=/usr/local/lib/node_modules` makes the global install resolvable.

## Step 2: Create browser.js

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

## Step 3: Create a test script to verify browser.js

Create a temporary test file `skills/browser_executor/scripts/test-browser.json`:

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

NOTE: If Docker build hasn't completed due to slow network, you can verify the JavaScript syntax instead:
```bash
node --check skills/browser_executor/scripts/browser.js
```
Expected: No output (syntax is valid).

## Step 4: Clean up test file and commit

```bash
rm skills/browser_executor/scripts/test-browser.json
git add -A
git commit -m "feat: browser_executor skill with Playwright script mode"
```

## Global Constraints

- Chromium binary at `/usr/bin/chromium` (system-installed, not Playwright-bundled)
- `NODE_PATH=/usr/local/lib/node_modules` (corrected in Task 1)
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` env var set in Dockerfile
- browser.js uses "script mode" — each invocation is a separate process, page state cannot persist across calls
