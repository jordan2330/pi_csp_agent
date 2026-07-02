# Pi CSP Agent — 亚硝胺商机发掘

基于 [Pi Coding Agent](https://pi.dev) 的 CSP（Aptar 活性包装）销售商机自动发掘系统。Agent 自动抓取 FDA 亚硝胺杂质风险 API 列表，逐一在中国药物临床试验登记平台搜索相关临床试验，匹配客户画像并生成包含 CSP 产品推荐的 Markdown 商机报告。

## 架构概览

```
┌──────────── Docker 容器 ────────────┐
│                                      │
│  Pi (Qwen LLM)                       │
│  ├─ prompts/lead-scan.md  入口命令   │
│  ├─ scenarios/nitrosamine/ 场景指令  │
│  └─ skills/browser_executor/ 浏览器  │
│       └─ browser.js (Playwright)     │
│                                      │
│  数据流：                             │
│  FDA页面 → API列表 → 临床试验搜索     │
│  → 客户匹配 → CSP推荐 → MD报告       │
└──────────────────────────────────────┘
```

- **Pi** 是大脑：读取 SKILL.md 指令，自主规划并执行
- **browser.js** 是手：Playwright 封装，在真实 Chromium 中操作网页
- **scenarios/** 是业务逻辑：每个场景一个独立 Skill，可插拔

## 前置要求

- **Docker** + **Docker Compose**（推荐 Docker 24+）
- **DashScope API Key**：在 [阿里云百炼](https://bailian.console.aliyun.com/) 控制台创建，模型包括 qwen3.7-max、deepseek-v4-pro、glm-5.2、kimi-k2.6 等
- **网络**：能访问 `dashscope.aliyuncs.com`、`fda.gov`、`chinadrugtrials.org.cn`

## 快速开始

```bash
# 1. 克隆仓库
git clone https://github.com/jordan2330/pi_csp_agent.git
cd pi_csp_agent

# 2. 配置 API Key
cp .env.example .env
nano .env
# 填入：DASHSCOPE_API_KEY=sk-你的key

# 3. 构建镜像（首次约 5-10 分钟，下载 apt 包和 npm 包）
docker compose build

# 4. 启动交互模式
docker compose run --rm csp-agent

# 5. 在 Pi TUI 中执行
/model qwen3.7-max          # 选择模型
/lead-scan nitrosamine      # 启动商机发掘
```

## 运行模式

### 交互式调试（开发推荐）

```bash
docker compose run --rm csp-agent
```

进入 Pi TUI 后可以：
- `/model qwen3.7-max` — 切换模型
- `/lead-scan nitrosamine` — 执行完整 pipeline
- 随时按 `Enter` 发送 steering 消息干预 Agent 行为
- 遇到验证码时 Agent 会暂停并说明情况，等待你的指示

### 自动无头运行（生产用）

```bash
docker compose run --rm csp-agent -p "/lead-scan nitrosamine"
```

`-p` 模式下 Pi 不启动 TUI，直接执行 prompt 并退出。遇到错误自动截图、跳过、继续下一个 API。

## 查看产出物

```bash
# 主报告 — 销售直接看的 Markdown 文件
cat output/CSP_Leads_Report.md

# 运行快照 — 每次运行的完整数据，用于增量对比
ls output/runs/

# FDA 缓存 — 每次运行自动刷新
cat config/fda_nitrosamines.json | python3 -m json.tool | head -20

# 修复文件归属（容器以 root 运行，生成的文件是 root 所有）
chown -R $(id -u):$(id -g) output/ config/
```

报告结构：
- **概览**：API 数量、临床试验数量、按风险等级分布
- **新增商机**：本次运行新发现的客户（最前面）
- **全量列表**：按 FDA Potency Cat 1→5 分组的所有客户

## 定时任务

每周一早上 8 点自动运行：

```bash
crontab -e
```

添加：
```cron
0 8 * * 1 cd /home/$USER/pi_csp_agent && docker compose run --rm csp-agent -p "/lead-scan nitrosamine" >> output/cron.log 2>&1 && chown -R $(id -u):$(id -g) output/ config/
```

> **注意**：`chown` 命令必须在 `docker compose run` 之后执行，将 root 生成的文件归属改回当前用户。`$GID` 在 bash 中不是标准变量，用 `$(id -g)` 代替。

## 扩展功能

### 新增业务场景

例如加一个「益生菌包装」场景：

```bash
mkdir -p scenarios/probiotics/references
```

创建 `scenarios/probiotics/SKILL.md`（参考 `scenarios/nitrosamine/SKILL.md` 的结构）：
- frontmatter：`name: probiotics` + `description`
- 三阶段 pipeline 指令：数据采集 → 搜索匹配 → 报告生成
- 中文编写

创建 `scenarios/probiotics/references/csp-recommendations.md`（CSP 产品推荐规则）

然后直接用：
```bash
/lead-scan probiotics
```

**不需要修改任何其他文件。** `.pi/settings.json` 已配置 `scenarios/` 自动发现。

### 增强浏览器能力

编辑 `skills/browser_executor/scripts/browser.js`，在 switch 中加新的 action：

```javascript
case 'scroll':
  await page.evaluate((sel) => {
    document.querySelector(sel)?.scrollIntoView({ behavior: 'smooth' });
  }, step.selector);
  break;
```

同时在 `skills/browser_executor/SKILL.md` 的 Action 表中更新说明。所有场景共享更新。

### 新增 Prompt 命令

在 `prompts/` 下创建 `.md` 文件，例如 `prompts/new-leads.md`：

```markdown
---
description: 只查看上次运行以来的新增商机
argument-hint: "<scenario>"
---
读取 output/runs/ 目录下最近两次快照，对比 $1 场景的新增项，
只输出新增商机列表，不重新爬取数据。
```

用法：`/new-leads nitrosamine`

## 已知限制

| 限制 | 说明 | 应对 |
|------|------|------|
| Docker 构建慢 | 首次下载 ~225MB apt 包 | 确保网络通畅，或配置 Debian 镜像源 |
| 网站反爬 | chinadrugtrials 可能有验证码 | browser.js 已内置反检测（隐藏 webdriver 标志、伪装 UA），首次运行时建议交互模式观察 |
| CSS 选择器失效 | 网站改版导致选择器不匹配 | SKILL.md 中指示 Agent 首次运行时截图分析页面结构，自主调整选择器 |
| 文件归属 root | 容器以 root 运行 | 运行后执行 `chown -R $(id -u):$(id -g) output/ config/` |
| FDA 季度更新 | FDA 页面每季度更新一次 | Agent 每次运行自动刷新，无需手动干预 |

## 故障排除

### `docker compose run` 报 API key 错误

检查 `.env` 文件是否存在且内容正确：
```bash
cat .env
# 应输出：DASHSCOPE_API_KEY=sk-...
```

### Pi TUI 中 `/lead-scan` 命令不存在

确认 `.pi/settings.json` 配置正确：
```bash
cat .pi/settings.json
# 应包含 "prompts": ["prompts/"]
```

### `git pull` 报 scripts/ 目录冲突

Agent 运行时会在 `scripts/` 下生成临时代码。`.gitignore` 已忽略该目录，如果仍有冲突：
```bash
git stash
git pull
git stash drop
```

### browser.js 报 `MODULE_NOT_FOUND: playwright`

Docker 镜像未正确构建。重新构建：
```bash
docker compose build --no-cache
```

### chinadrugtrials 搜索结果为空

1. 用截图模式检查页面是否正常加载：
   ```bash
   docker compose run --rm csp-agent bash -c "node skills/browser_executor/scripts/browser.js screenshot https://www.chinadrugtrials.org.cn/clinicaltrials.searchlist.dhtml /tmp/test.png"
   ```
2. 在容器内查看截图：
   ```bash
   docker compose run --rm --entrypoint bash csp-agent -c "ls /tmp/*.png"
   ```
3. 可能需要更新 SKILL.md 中的 CSS 选择器

## 项目结构

```
pi-csp-agent/
├── Dockerfile, docker-compose.yml, .env.example
├── AGENTS.md                          # Pi 项目指令（Agent 启动时自动加载）
├── .pi/settings.json                  # Pi 配置：skills/prompts 路径
├── config/
│   ├── models.json                    # Qwen 模型配置
│   └── fda_nitrosamines.json          # FDA 数据缓存（自动生成）
├── skills/browser_executor/
│   ├── SKILL.md                       # 浏览器工具使用说明
│   └── scripts/browser.js             # Playwright 自动化脚本
├── scenarios/nitrosamine/
│   ├── SKILL.md                       # 亚硝胺场景三阶段 pipeline
│   └── references/csp-recommendations.md  # CSP 产品推荐规则
├── prompts/lead-scan.md               # 入口命令 /lead-scan <scenario>
└── output/
    ├── CSP_Leads_Report.md            # 商机报告
    └── runs/                          # 运行快照（增量对比用）
```

## License

MIT
