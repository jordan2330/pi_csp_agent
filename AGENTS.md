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
