# AGENTS.md

## Project Overview

This is a Pi Coding Agent project for CSP (Aptar active packaging) sales lead discovery. The agent scrapes regulatory and clinical trial data, matches customer profiles, and generates Markdown lead reports.

## LLM Configuration

- Provider: Aliyun DashScope (百炼) via OpenAI-compatible API
- Endpoint: `https://dashscope.aliyuncs.com/compatible-mode/v1`
- Models: `qwen3.7-max` / `deepseek-v4-pro` / `glm-5.2` / `kimi-k2.6` for complex reasoning, `qwen3.7-plus` / `deepseek-v4-flash` for routine tasks
- Config: `config/models.json` → mounted to `/home/piuser/.pi/agent/models.json` in Docker (容器以宿主机 UID 运行，非 root)
- API key: `DASHSCOPE_API_KEY` environment variable
- All models use `thinkingFormat: "qwen"` (Aliyun unified endpoint)

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
