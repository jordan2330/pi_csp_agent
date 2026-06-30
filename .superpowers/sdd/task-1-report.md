# Task 1 Report: Project Scaffolding & Docker

**Status:** DONE_WITH_CONCERNS
**Commit:** `4ce2cec` — `chore: project scaffolding and Docker setup`
**Date:** 2026-06-30

---

## 1. What I Implemented

Created the 5 scaffolding files **exactly as specified** in the task brief (verified against `git show HEAD:<file>`):

| File | Content | Matches spec |
|------|---------|--------------|
| `.gitignore` | `.env`, `output/runs/`, `node_modules/`, `*.log` (4 lines) | ✅ verbatim |
| `.env.example` | `DASHSCOPE_API_KEY=` | ✅ verbatim |
| `output/.gitkeep` | empty (0 bytes) | ✅ verbatim |
| `Dockerfile` | 17 lines, `node:24-bookworm-slim` + apt + npm + `ENTRYPOINT ["pi"]` | ✅ verbatim |
| `docker-compose.yml` | 13 lines, `csp-agent` service + `pi-agent-home` volume | ✅ verbatim |

**Git:** Initialized repo (`git init`), staged all files (`git add -A`), committed as `4ce2cec`. This is the root commit (12 files, 1912 insertions). Git identity was already configured globally (Jordan Guo / ya_ti@live.cn) — no git config changes were made.

**Existing files preserved unmodified:** `CSP.md`, `20260616_6月上新亚硝胺药物分析杂质.md`, `AGENTS.md`, `docs/` (plans + specs), `.superpowers/`. These were added to the commit as-is; their content was not edited.

---

## 2. What I Tested & Test Results

### 2.1 Environment discovery
- `docker` is **not** on the Windows PATH and Docker Desktop is not installed.
- Docker **is** available inside WSL distro `Ubuntu-20.04` (`dockerd 27.5.0`, containerd 1.7.25). The daemon socket required root, so builds were run via `wsl -d Ubuntu-20.04 -u root`.

### 2.2 Exact build: `docker build -t pi-csp-agent .` (spec Dockerfile)
- **Buildkit metadata error on first attempt** (`failed size validation: 7940 != 7667`) while resolving `node:24-bookworm-slim`. This was a buildkit cache-state issue, **not** a Dockerfile defect.
- **Resolved by pre-pulling the base image:** `docker pull node:24-bookworm-slim` succeeded (exit 0). After this, `#4 FROM node:24-bookworm-slim` → `CACHED` and metadata resolved cleanly (`#2 DONE 0.0s`).
- The build then entered `#5 RUN apt-get update && apt-get install ...` and progressed correctly:
  - `apt-get update` succeeded
  - Dependency tree resolved: **194 packages** including `chromium`, `fonts-wqy-zenhei`, `git`, `ripgrep`, `ca-certificates` (all found in the bookworm repos — no missing-package errors)
  - `225 MB` of archives queued for download
- **Blocked by network throughput:** `Fetched 9365 kB in 11min 5s (14.1 kB/s)`. The WSL environment reaches `deb.debian.org` at ~14 kB/s. Downloading 225 MB at that rate takes ~4.5 hours, which is infeasible within session timeouts (two 30-min runs were both killed mid-`apt-download`). **This is an environment limitation, not a Dockerfile defect** — the build has no errors up through dependency resolution.

### 2.3 Verification build via temporary `Dockerfile.test` (mirror swap)
To verify the **remaining** build steps (apt install completion + npm installs) that the slow mirror otherwise prevents, I built a temporary `Dockerfile.test` identical to the spec **except** for two environment-only tweaks:
- apt mirror: `http://mirrors.aliyun.com/debian` (HTTP, since the slim base lacks `ca-certificates` until apt installs it — the spec's use of `http://deb.debian.org` is correct for the same reason)
- npm registry: `https://registry.npmmirror.com`

The **committed `Dockerfile` was not modified** — `Dockerfile.test` was an untracked verification artifact and has been deleted.

**Result: `TEST_BUILD_SUCCEEDED` (exit 0).** Log: `C:\Users\guoj01\AppData\Local\Temp\opencode\build_test.log`

| Build step | Result |
|------------|--------|
| `#4 FROM node:24-bookworm-slim` | CACHED |
| `#5 apt-get install` (194 pkgs, 225 MB) | DONE 211.1s — chromium 149.0.7827.196, fonts-wqy-zenhei, git 2.39.5, ripgrep 13.0.0, ca-certificates all `Setting up` |
| `#6 npm install -g pi-coding-agent` | `added 140 packages in 14s` |
| `#6 npm install -g playwright` | `added 2 packages in 8s` (browser download skipped via `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=true`) |
| `#7 WORKDIR /workspace` | DONE |
| `#8 export image` | `pi-csp-agent-test:latest`, 1.21GB |

Since `Dockerfile.test` differs from the spec **only** in apt/npm mirror source (all package names, env vars, install commands, WORKDIR, and ENTRYPOINT are identical), this verifies the spec Dockerfile's build steps are correct and will complete given adequate network bandwidth.

### 2.4 Runtime verification (against `pi-csp-agent-test` image)
Run with `--entrypoint bash` (the image's ENTRYPOINT is `["pi"]`, so a plain `docker run ... bash -c` would invoke `pi` instead of bash — that's why an earlier verify attempt printed "No API key found"):

| Check | Result |
|-------|--------|
| `which chromium` | `/usr/bin/chromium` ✅ (matches `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`) |
| `chromium --version` | `Chromium 149.0.7827.196` ✅ |
| `which git` | `/usr/bin/git` ✅ |
| `which rg` | `/usr/bin/rg` ✅ |
| `which pi` | `/usr/local/bin/pi` ✅ |
| `NODE_PATH` | `/usr/lib/node_modules` (as set by Dockerfile) |
| `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` | `true` ✅ |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | `/usr/bin/chromium` ✅ |
| `WORKDIR` | `/workspace` ✅ |

---

## 3. Files Changed

Single root commit `4ce2cec` (12 files, +1912):
- **New scaffolding (this task):** `.gitignore`, `.env.example`, `Dockerfile`, `docker-compose.yml`, `output/.gitkeep`
- **Pre-existing, added as-is (not modified):** `CSP.md`, `20260616_6月上新亚硝胺药物分析杂质.md`, `AGENTS.md`, `docs/superpowers/plans/2026-06-30-csp-lead-agent.md`, `docs/superpowers/specs/2026-06-30-csp-lead-agent-design.md`, `.superpowers/sdd/progress.md`, `.superpowers/sdd/task-1-brief.md`

No existing file content was modified or deleted.

---

## 4. Self-Review Findings

- ✅ All 5 files created exactly as specified (byte-for-byte verified via `git show`).
- ✅ Git initialized; single commit `4ce2cec` with the prescribed message.
- ✅ Existing files (`CSP.md`, `20260616_*.md`, `docs/`) unmodified.
- ✅ Docker build verified end-to-end (via mirror-swap `Dockerfile.test`): image builds, all apt packages install, both npm installs succeed, chromium/pi/playwright present at runtime, env vars and WORKDIR correct.
- ✅ Temporary `Dockerfile.test` deleted; working tree clean (`git status` empty).
- ⚠️ The **exact** `docker build -t pi-csp-agent .` could not complete in-session due to the WSL environment's ~14 kB/s throughput to `deb.debian.org` (225 MB apt download ≈ 4.5 h). The build is proven valid by (a) the exact Dockerfile progressing cleanly through apt dependency resolution with zero errors, and (b) the mirror-swap build completing successfully with identical package/env/ENTRYPOINT steps.

---

## 5. Issues & Concerns

### Concern 1 (IMPORTANT — likely spec defect): `NODE_PATH` points to a non-existent directory

The Dockerfile sets `ENV NODE_PATH=/usr/lib/node_modules`, and the task brief's Global Constraints state this is "required so browser.js can `require('playwright')`." Runtime verification proves this does **not** work:

```
npm prefix: /usr/local
npm root -g: /usr/local/lib/node_modules
/usr/lib/node_modules: No such file or directory        # <- NODE_PATH target doesn't exist
/usr/local/lib/node_modules: contains @earendil-works, corepack, npm, playwright

require('playwright') with NODE_PATH=/usr/lib/node_modules        -> FAIL: MODULE_NOT_FOUND
require('playwright') with NODE_PATH=/usr/local/lib/node_modules  -> OK (object)
require('playwright') with NODE_PATH=/usr/lib/node_modules:/usr/local/lib/node_modules -> OK
```

In `node:24-bookworm-slim`, `npm install -g` places modules in `/usr/local/lib/node_modules` (the default npm prefix), **not** `/usr/lib/node_modules`. As a result, with the spec's `NODE_PATH`, any `require('playwright')` from `browser.js` (or any code resolving against `NODE_PATH`) will throw `MODULE_NOT_FOUND` at runtime.

**Recommended fix (not applied — kept Dockerfile verbatim per "exactly as specified"):**
```dockerfile
ENV NODE_PATH=/usr/local/lib/node_modules
```
This should be decided by the plan author since it changes the spec.

### Concern 2 (environment): Infeasible to fully build the exact `pi-csp-agent` image in this session

The WSL environment downloads from `deb.debian.org` at ~14 kB/s. A full `docker build -t pi-csp-agent .` (225 MB apt + npm) would take hours. To produce the actual `pi-csp-agent` image, run the build in an environment with adequate bandwidth to `deb.debian.org` (or behind a Debian mirror). Note: the base image `node:24-bookworm-slim` is already cached in the WSL docker, and the buildkit metadata issue was cleared by the pre-pull, so a future build should start cleanly.

### Test artifacts left behind (harmless)
- Docker image `pi-csp-agent-test:latest` (1.21GB) — kept as build evidence; remove with `docker rmi pi-csp-agent-test` if undesired.
- Docker image `node:24-bookworm-slim` (227MB) — base image, cached.
- Build logs under `C:\Users\guoj01\AppData\Local\Temp\opencode\` (`build_test.log`, `verify_run.log`, `verify2_run.log`, `build_run.log`) — outside the repo.
