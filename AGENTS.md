# AGENTS.md

## Repository nature

This is a **documentation-only knowledge base**, not a software project. There is no source code, no build system, no test suite, no linter, no package manager, and **no git repository initialized**. Do not look for or suggest running `build`/`test`/`lint`/`typecheck` commands, and do not propose git workflows (commit, branch, PR) unless the user first initializes git.

## Content domain & language

All content is written in **Simplified Chinese** and covers pharmaceutical packaging and drug-impurity topics:

- `CSP.md` — Comparative analysis of Aptar CSP active packaging technologies (Activ-Vial®, Activ-Film®, Activ-Blister®, 3-Phase Activ-Polymer™, Activ-Sachet®, custom adsorbents). Contains performance data tables, regulatory status, cost/scalability notes, case studies, and a numbered source list with external URLs.
- `20260616_6月上新亚硝胺药物分析杂质.md` — USP Pharmaceutical Analytical Impurities (PAI) nitrosamine series update. Lists newly released nitrosamine impurities (Chinese/English name, USP catalog number, CAS) and a roster of ~100 affected active pharmaceutical ingredients.

When editing, preserve the bilingual (Chinese name + English name) conventions and the existing table structures, since they mirror USP/Aptar reference formats.

## File naming convention

Time-sensitive update notes use a `YYYYMMDD_` date prefix (e.g. `20260616_...`). Topical reference documents (e.g. `CSP.md`) use a short uppercase mnemonic with no date. Follow this convention when adding new files: date-prefixed for periodic updates, plain mnemonic for standing reference material.

## Citations & sources

`CSP.md` ends with a numbered `[n]` source list of external URLs, and inline references use the same `[n]` markers. When adding claims that rely on external data, append a new numbered source entry and cite it inline; do not leave bare `【...】` placeholders (a few exist in the current file and should be replaced with real sources when available).
