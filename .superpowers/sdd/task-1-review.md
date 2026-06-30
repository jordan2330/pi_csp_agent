# Task 1 Review: Project Scaffolding & Docker

**Reviewer:** Task reviewer (automated)
**Reviewed commits:** `4ce2cec` (scaffolding) + `6c2dcb0` (NODE_PATH fix)
**Date:** 2026-06-30

---

## 1. Spec Compliance: ✅

| Brief requirement | Status | Evidence |
|---|---|---|
| Create `.gitignore` (4 lines: `.env`, `output/runs/`, `node_modules/`, `*.log`) | ✅ | `C:\app\pi_csp_agent\.gitignore` — byte-for-byte match |
| Create `.env.example` (`DASHSCOPE_API_KEY=`) | ✅ | `C:\app\pi_csp_agent\.env.example` — verbatim |
| Create `output/.gitkeep` (empty) | ✅ | 0-byte file present |
| Create `Dockerfile` (node:24-bookworm-slim + apt + npm + ENTRYPOINT `["pi"]`) | ✅ | 17 lines, matches spec (with the approved NODE_PATH correction in `6c2dcb0`) |
| Create `docker-compose.yml` (csp-agent service + pi-agent-home volume) | ✅ | 13 lines, verbatim match |
| `git init` + `git add -A` + commit `chore: project scaffolding and Docker setup` | ✅ | `4ce2cec` is the root commit, 12 files, +1912, exact message |
| Existing files (`CSP.md`, `20260616_*.md`, `AGENTS.md`, `docs/`, `.superpowers/`) preserved unmodified | ✅ | `git show 4ce2cec --stat` lists them as additions (not modifications); `Test-Path` confirms all three top-level files still exist |
| Docker image builds (`docker build -t pi-csp-agent .`) | ⚠️ See §3 | Build proven correct via mirror-swap test; exact build blocked by environment network throughput (14 kB/s to deb.debian.org) — environment limitation, not code defect |

---

## 2. Code Quality: Approved

### Dockerfile (current, post-fix)
```dockerfile
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       bash ca-certificates git ripgrep \
       chromium fonts-wqy-zenhei \
  && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=true
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_PATH=/usr/local/lib/node_modules

RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent
RUN npm install -g playwright

WORKDIR /workspace
ENTRYPOINT ["pi"]
```
- **Base image:** `node:24-bookworm-slim` — correct, matches spec and the `NODE_PATH=/usr/local/...` fix (Node official images install to `/usr/local`).
- **apt layer:** `--no-install-recommends` keeps the image lean; `rm -rf /var/lib/apt/lists/*` cleans cache in the same layer (good Docker practice). Package set is correct: `chromium` + `fonts-wqy-zenhei` (CJK font for Chinese rendering) + `git`/`ripgrep` (pi-coding-agent dependencies) + `ca-certificates`/`bash`.
- **Env vars:** `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=true` avoids redundant 150MB browser download (system chromium is used instead). `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium` matches the apt-installed path — confirmed at runtime (`which chromium` → `/usr/bin/chromium`).
- **npm layers:** Two separate `RUN` statements — slightly less cache-efficient than a combined `&&`, but acceptable and clearer. `--ignore-scripts` on pi-coding-agent is the right call (avoids any postinstall surprises).
- **WORKDIR / ENTRYPOINT:** `/workspace` matches the compose volume mount; `["pi"]` is the correct entrypoint.

### docker-compose.yml
- Valid YAML, top-level `services:` and `volumes:` keys.
- `DASHSCOPE_API_KEY=${DASHSCOPE_API_KEY}` — correctly forwards the host env var (populated from `.env` via Compose's default env-file loading).
- Volume mounts are right: `.:/workspace` (project files, matches WORKDIR) and named volume `pi-agent-home:/root/.pi/agent` (persists pi agent state across container recreations).
- `stdin_open: true` + `tty: true` — necessary for interactive `pi` sessions. Correct.

### .gitignore
- Covers the four required patterns. `.env` is properly ignored (secrets), while `.env.example` remains tracked. `output/runs/` ignores runtime artifacts but keeps `output/.gitkeep`. `node_modules/` and `*.log` are standard. No issues.

---

## 3. The NODE_PATH Fix: Verified Correct

**The bug:** The task brief specified `ENV NODE_PATH=/usr/lib/node_modules`, claiming this is "required so browser.js can `require('playwright')`." On `node:24-bookworm-slim`, npm's global prefix is `/usr/local`, so `npm install -g playwright` places the module at `/usr/local/lib/node_modules/playwright` — **not** under `/usr/lib/node_modules` (which doesn't exist on this image).

**Evidence from the implementer's runtime verification** (against the mirror-swap test image, identical apart from apt/npm mirror source):
```
npm prefix: /usr/local
npm root -g: /usr/local/lib/node_modules
/usr/lib/node_modules: No such file or directory
require('playwright') with NODE_PATH=/usr/lib/node_modules        -> FAIL: MODULE_NOT_FOUND
require('playwright') with NODE_PATH=/usr/local/lib/node_modules  -> OK (object)
```

**The fix (commit `6c2dcb0`):** Single-line change in `Dockerfile`:
```diff
-ENV NODE_PATH=/usr/lib/node_modules
+ENV NODE_PATH=/usr/local/lib/node_modules
```

**Verdict:** ✅ Correct. This matches Node.js official Docker image conventions and is verified by runtime `require()` testing. The spec was wrong; the fix is right. The brief's Global Constraints line 93 (`NODE_PATH=/usr/lib/node_modules required...`) should be updated in any downstream briefs that copy from it.

**Independently confirmed:** I verified the current `Dockerfile` on disk (`C:\app\pi_csp_agent\Dockerfile:11`) reads `ENV NODE_PATH=/usr/local/lib/node_modules`, and `git log` shows both commits in order (`4ce2cec` then `6c2dcb0`). The diff `review-4ce2cec..6c2dcb0.diff` shows exactly this one-line change and nothing else.

---

## 4. Issues

### Critical
None.

### Important
None. (The NODE_PATH spec defect was the only important concern; it has been fixed in `6c2dcb0`.)

### Minor
1. **Exact `docker build` not run to completion in-session.** The full build against `deb.debian.org` was blocked by ~14 kB/s network throughput in the WSL environment (225 MB apt download ≈ 4.5 h). The implementer mitigated this correctly via a mirror-swap `Dockerfile.test` that is identical to the spec Dockerfile except for apt/npm mirror source — this verified all build steps (apt install of 194 packages, both npm installs, WORKDIR, image export) complete successfully. The exact build should be run once in a bandwidth-adequate environment to produce the canonical `pi-csp-agent:latest` image. **This is an environment limitation, not a code defect — accepted as documented.**

2. **SDD workflow artifacts untracked.** `git status` shows two untracked files: `.superpowers/sdd/task-1-report.md` and `.superpowers/sdd/review-4ce2cec..6c2dcb0.diff`. These are SDD process files, not project artifacts, and were not in the brief's scope. The `.gitignore` doesn't cover them, but they shouldn't be committed to the project repo. No action required for Task 1; the SDD tooling manages these.

3. **Test image left behind.** `pi-csp-agent-test:latest` (1.21GB) and `node:24-bookworm-slim` (227MB) Docker images remain in the WSL docker cache. Harmless, but can be removed with `docker rmi pi-csp-agent-test` if disk space is a concern. Not a code issue.

---

## 5. Overall: ✅ Approved

Task 1 is complete and correct. All 5 specified files exist with the right content, git is initialized with the prescribed commit message, existing documentation files are preserved unmodified, and the Dockerfile builds successfully (verified via mirror-swap). The one spec defect discovered (`NODE_PATH` pointing to a non-existent directory) was correctly diagnosed, documented with runtime evidence, and fixed in a follow-up commit (`6c2dcb0`) that the controller has already applied. No further action is required to close out Task 1.

The task is ready to hand off to Task 2.
