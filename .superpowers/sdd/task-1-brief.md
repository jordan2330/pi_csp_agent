# Task 1: Project Scaffolding & Docker

**Files:**
- Create: `.gitignore`
- Create: `.env.example`
- Create: `output/.gitkeep`
- Create: `Dockerfile`
- Create: `docker-compose.yml`

**Interfaces:**
- Produces: A Docker image named `pi-csp-agent` that runs Pi with Playwright support

## Steps

### Step 1: Create .gitignore

```
.env
output/runs/
node_modules/
*.log
```

### Step 2: Create .env.example

```
DASHSCOPE_API_KEY=
```

### Step 3: Create output/.gitkeep

Empty file to ensure the output directory exists in git.

### Step 4: Create Dockerfile

```dockerfile
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       bash ca-certificates git ripgrep \
       chromium fonts-wqy-zenhei \
  && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=true
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_PATH=/usr/lib/node_modules

RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent
RUN npm install -g playwright

WORKDIR /workspace
ENTRYPOINT ["pi"]
```

### Step 5: Create docker-compose.yml

```yaml
services:
  csp-agent:
    build: .
    environment:
      - DASHSCOPE_API_KEY=${DASHSCOPE_API_KEY}
    volumes:
      - .:/workspace
      - pi-agent-home:/root/.pi/agent
    stdin_open: true
    tty: true

volumes:
  pi-agent-home:
```

### Step 6: Initialize git and verify Docker build

```bash
git init
git add -A
git commit -m "chore: project scaffolding and Docker setup"
```

Verify Docker image builds:
```bash
docker build -t pi-csp-agent .
```
Expected: Build succeeds with no errors.

## Global Constraints

- LLM provider: Qwen via DashScope, not Anthropic
- API key env var: `DASHSCOPE_API_KEY`
- Chromium binary at `/usr/bin/chromium` (system-installed, not Playwright-bundled)
- `NODE_PATH=/usr/lib/node_modules` required so browser.js can `require('playwright')`
- All content instructions in SKILL.md files are in Simplified Chinese
- No git repo exists yet — Task 1 initializes it
