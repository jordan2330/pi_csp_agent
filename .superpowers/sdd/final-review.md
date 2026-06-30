# Final Whole-Branch Code Review — CSP Lead Agent

> **Branch range:** `4ce2cec..b1fd458` (5 commits)
> **Reviewer date:** 2026-06-30
> **Spec:** `docs/superpowers/specs/2026-06-30-csp-lead-agent-design.md`

## Summary

The branch delivers a working skeleton for the CSP lead-discovery Pi agent: a Playwright browser tool, a three-phase nitrosamine scenario skill, the `/lead-scan` entry prompt, Qwen/DashScope model config, and a corrected Dockerfile. The implementation is faithful to the approved spec; deviations are minor, justified, and documented.

---

## 1. Spec compliance — ✅

Every file from the spec's project structure (§3) is present and matches its intended content:

| Spec path | Status | Notes |
|---|---|---|
| `docker-compose.yml` | ✅ | Adds the `models.json` bind mount the spec described in prose but omitted from its compose example — an improvement |
| `Dockerfile` | ✅ | `NODE_PATH` corrected to `/usr/local/lib/node_modules` (runtime-verified) |
| `.env.example` | ✅ | `DASHSCOPE_API_KEY=` template, committable |
| `.env` | n/a | Not committed, as spec requires |
| `AGENTS.md` | ✅ | Rewritten from "doc-only repo" to Pi project instructions |
| `.pi/settings.json` | ✅ | Maps `skills/`, `scenarios/`, `prompts/` — matches spec §3 exactly |
| `config/models.json` | ✅ | Qwen provider config — matches spec §4 byte-for-byte in intent |
| `config/fda_nitrosamines.json` | n/a | Auto-generated at runtime; correctly absent from initial tree |
| `skills/browser_executor/SKILL.md` | ✅ | Has required frontmatter (`name`, `description`) |
| `skills/browser_executor/scripts/browser.js` | ✅ | 171-line Playwright wrapper |
| `scenarios/nitrosamine/SKILL.md` | ✅ | Three-phase pipeline instructions |
| `scenarios/nitrosamine/references/csp-recommendations.md` | ✅ | Potency-category → CSP recommendation matrix |
| `prompts/lead-scan.md` | ✅ | Entry template with `$1` scenario argument |
| `output/` | ✅ | Present with `.gitkeep` |

Additions beyond the spec (both reasonable): `skills/browser_executor/scripts/package.json` (declares the `playwright` dep for local dev) and `output/.gitkeep`.

## 2. browser.js code quality — Approved (minor improvements recommended)

The script is small, focused, and does what the SKILL.md advertises. `navigate` / `type` / `click` / `wait` / `extract` / `screenshot` actions all map to sensible Playwright calls. Cookie persistence across invocations via `/tmp/browser-state.json` correctly implements the spec's "持久化浏览器上下文" requirement (§5).

**Confirmed known issue:** `const path = require('path')` (line 5) is unused — this is the only code-quality defect flagged pre-review, and it is indeed the only outright dead code. ✅

**Additional findings (all minor):**

1. **`process.exit(1)` in the `catch` of `runScript` (line 130) bypasses `finally { await browser.close() }` (line 131-133).** `process.exit()` terminates synchronously and does not unwind the `finally` block, so on any step failure the Chromium process is not gracefully closed. Impact is low in the Docker target (container teardown reaps orphaned Chromium), but it can leak processes on non-Docker local runs. Cleaner pattern: `await browser.close()` in the catch before exiting, or re-`throw` and let `finally` run, then exit from an outer handler.

2. **Inconsistent "element not found" behavior in `extract`.** `format: 'json'` uses `page.evaluate` and silently pushes `null` when the selector matches nothing (line 102); `format: 'text'` uses `page.textContent(..., {timeout})` which throws on timeout (line 104). The SKILL.md says "任何步骤失败，整个脚本终止" — the json branch violates that contract by returning null instead of failing. Consider making missing-element behavior consistent (either both throw, or both return null with a documented convention).

3. **No built-in retry.** Spec §5 lists "内置重试和等待逻辑" as a design decision, but `browser.js` has none — retry is delegated to the orchestrating LLM via the nitrosamine SKILL.md's "重试 3 次" instruction. This is a defensible design shift (the LLM is better at adaptive retry than a rigid loop), and it is the right call for an LLM-orchestrated tool, but it is a deviation from the spec's wording. Worth a one-line note in `browser_executor/SKILL.md` so the LLM knows retry is its job.

4. **`runScreenshot` doesn't set a custom `userAgent`** (lines 143-146) while `runScript` does (line 46). Minor inconsistency; the screenshot path is debug-only so impact is negligible.

5. **`networkidle` waitUntil** can hang on sites with persistent connections (chinadrugtrials may qualify). Mitigated by the `timeout` on every `goto`, so worst case is a controlled error, not an infinite hang. Acceptable.

## 3. Dockerfile correctness — Approved

- `NODE_PATH=/usr/local/lib/node_modules` ✅ (corrected; verified at runtime — npm globals land here on `node:24-bookworm-slim`).
- `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=true` + `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium` correctly pair with the system `chromium` apt package, avoiding Playwright's own browser download.
- `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` — `--ignore-scripts` correctly prevents any postinstall that might fetch Playwright browsers.
- `npm install -g playwright` + `NODE_PATH` makes `require('playwright')` resolve in `browser.js` despite no local `node_modules`. Correct.
- `fonts-wqy-zenhei` ensures Chinese renders. Good.

**Minor issue (Dockerfile):** no version pinning on either npm package (`@earendil-works/pi-coding-agent`, `playwright`) and no base-image digest pin. Builds are not reproducible — a future `npm install` could pull a breaking Playwright or agent version. For an internal tool this is acceptable, but pinning (e.g. `playwright@1.49.1`) would be a low-cost robustness win.

No other Dockerfile issues found.

## 4. SKILL.md quality — Approved

**`scenarios/nitrosamine/SKILL.md`** is thorough and LLM-friendly:
- Clear three-phase structure with goals, steps, and expected output schemas for each phase.
- Concrete JSON script examples the LLM can emit verbatim then refine.
- Explicit field lists for extraction (sponsor, status, indication, phase, etc.).
- Incremental-detection logic (new API / new trial / status change) is well-specified.
- Error handling per phase matches spec §10.

**CSS selectors** (`input[name='keywords']`, `.search-btn`, `.list, .result, table`) are best-guess, as acknowledged. The critical mitigation is present: line 154 explicitly instructs the LLM to first screenshot the live page and adjust selectors at runtime. This is the correct approach for a site whose markup may shift, and it matches the known-limitation note. The selectors are reasonable starting points.

**`browser_executor/SKILL.md`** is clear and accurately documents the implemented `script` / `screenshot` modes and the six actions. One small gap: it doesn't explicitly say "retry is the caller's responsibility" (see browser.js finding #3) — adding that line would close the loop with the nitrosamine SKILL.md's retry instruction.

**`prompts/lead-scan.md`** correctly uses `$1` for the scenario argument, pre-loads `browser-executor`, and gives mode-aware error guidance (interactive pause vs. auto-mode skip). Good.

## 5. Configuration correctness — ✅

**`config/models.json`:**
- `baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1"` ✅ DashScope OpenAI-compatible endpoint.
- `api: "openai-completions"` ✅
- `apiKey: "$DASHSCOPE_API_KEY"` ✅ Pi env-var interpolation syntax.
- `compat.thinkingFormat: "qwen"` ✅ Pi's native DashScope thinking-format support.
- `qwen-max` (32k ctx, 8192 out, `reasoning: false`) and `qwen-plus` (131k ctx) ✅ match spec §4.
- All `cost` fields `0` ✅ token-plan billing, not pay-per-token.

Matches the spec exactly.

**`.pi/settings.json`:** `skills: ["skills/", "scenarios/"]`, `prompts: ["prompts/"]` ✅ maps to the repo layout so Pi discovers both the shared tool skill and the per-scenario skills.

**`docker-compose.yml` volume mount** `./config/models.json:/root/.pi/agent/models.json:ro` correctly places the config where Pi reads it (`/root/.pi/agent/models.json`), matching the spec. The `:ro` flag is a sensible guard to prevent Pi from overwriting the author-provided config — **one caveat:** if `pi-coding-agent` attempts to write/normalize `models.json` at startup, the read-only mount would cause a write failure. This is low-risk (we intend our config to be authoritative) but should be confirmed during the pending E2E test. If Pi does write there, drop `:ro`.

The `pi-agent-home` named volume at `/root/.pi/agent` plus the file bind-mount at `/root/.pi/agent/models.json` is a supported Docker pattern (file overlay on a volume path) — no conflict.

---

## Issue Register

### Critical issues
None.

### Important issues
None blocking merge.

### Minor issues
1. **`const path = require('path')` unused** in `browser.js:5` — known, confirmed as the only dead code. *(pre-flagged)*
2. **`process.exit(1)` in `runScript` catch bypasses `browser.close()` in `finally`** — can orphan Chromium on error (low impact in Docker, possible leak locally). `browser.js:130`.
3. **Inconsistent not-found behavior in `extract`** — `format:'json'` returns `null` silently; `format:'text'` throws on timeout. `browser.js:102` vs `:104`.
4. **No built-in retry in browser.js** — spec §5 mentioned "内置重试"; retry is delegated to the LLM via SKILL.md. Document this explicitly in `browser_executor/SKILL.md`.
5. **`runScreenshot` omits the custom `userAgent`** that `runScript` sets. `browser.js:143-146`.
6. **FDA extract uses generic `selector: "table"`** (first-table match) — may need refinement if the FDA page has multiple tables; mitigated by the SKILL.md's runtime selector-verification guidance.
7. **No version pinning** in Dockerfile npm installs — non-reproducible builds.
8. **`:ro` on `models.json` mount** could break if pi-coding-agent writes/normalizes that file at startup — verify during E2E; drop `:ro` if needed.
9. **Spec deviation (justified, documented):** browser.js exposes "script mode" (JSON step file) as the primary interface rather than the spec §5's individual per-action CLI subcommands. This is the right design — each invocation is a separate process, so per-action calls would lose page state anyway — and it is documented in `AGENTS.md` and `browser_executor/SKILL.md`. No action required; noted for completeness.

### Known limitations (acknowledged, not blockers)
- Docker build not fully tested (slow `deb.debian.org`; verified via mirror-swap).
- E2E not run (requires Docker build + `DASHSCOPE_API_KEY`).
- chinadrugtrials CSS selectors are best-guess; LLM verifies at runtime per SKILL.md line 154.

---

## Overall — ✅ Ready to merge

The branch delivers a complete, spec-compliant skeleton with correct Qwen/DashScope configuration, a functional Playwright tool, and clear LLM-followable scenario instructions. No critical or important issues block merge. The minor issues are cosmetic, edge-case, or explicitly acknowledged; several (retry delegation, script-mode interface) are deliberate design improvements over the spec rather than defects. Recommend merging now and addressing minor items #1–#3 as a quick follow-up before the first real E2E run.
