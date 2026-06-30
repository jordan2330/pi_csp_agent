# Task 2: Pi Configuration (Qwen + Settings + AGENTS.md)

**Files:**
- Create: `.pi/settings.json`
- Create: `config/models.json`
- Create: `AGENTS.md` (overwrite the existing one — it was a documentation-only repo placeholder; the new content is the Pi project instructions)

**Interfaces:**
- Consumes: `DASHSCOPE_API_KEY` environment variable
- Produces: Pi configuration that loads Qwen models and maps skills/prompts paths

## Steps

### Step 1: Create .pi/settings.json

```json
{
  "skills": ["skills/", "scenarios/"],
  "prompts": ["prompts/"]
}
```

### Step 2: Create config/models.json

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

### Step 3: Create AGENTS.md

IMPORTANT: The existing AGENTS.md is a placeholder from when this was a documentation-only repo. Overwrite it completely with the new Pi project instructions below.

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

### Step 4: Update docker-compose.yml to mount models.json

The current docker-compose.yml (from Task 1) has these volumes:
```yaml
    volumes:
      - .:/workspace
      - pi-agent-home:/root/.pi/agent
```

Add a third line to mount models.json into Pi's agent home:
```yaml
    volumes:
      - .:/workspace
      - pi-agent-home:/root/.pi/agent
      - ./config/models.json:/root/.pi/agent/models.json:ro
```

### Step 5: Verify and commit

Verify all files are created correctly, then:
```bash
git add -A
git commit -m "feat: Pi configuration with Qwen provider and project instructions"
```

## Global Constraints

- LLM provider: Qwen via DashScope (`https://dashscope.aliyuncs.com/compatible-mode/v1`), not Anthropic
- API key env var: `DASHSCOPE_API_KEY`
- Pi's native `thinkingFormat: "qwen"` compat flag must be set in models.json
- `NODE_PATH=/usr/local/lib/node_modules` (corrected in Task 1)
- All content instructions in SKILL.md files are in Simplified Chinese
