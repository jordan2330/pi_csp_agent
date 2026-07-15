# Pi CSP Agent — 亚硝胺商机发掘

基于 [Pi Coding Agent](https://pi.dev) 的 CSP（Aptar 活性包装）销售商机自动发掘系统。Agent 自动抓取 FDA 亚硝胺杂质风险 API 列表，逐一在中国药物临床试验登记平台搜索相关临床试验，匹配客户画像并生成包含 CSP 产品推荐的 Markdown 商机报告。

## 架构概览

```
┌──────────── Docker 容器 ────────────┐    ┌─ Browserless ─┐
│                                      │    │               │
│  Pi (Qwen LLM)                       │───→│  Chromium      │──→ FDA
│  ├─ prompts/lead-scan.md  入口命令   │    │  (headless=   │──→ chinadrugtrials
│  ├─ scenarios/nitrosamine/ 场景指令  │    │   false 可VNC) │──→ ClinicalTrials.gov
│  └─ skills/browser_executor/ 浏览器  │    │               │
│       └─ browser.js (Playwright)     │    └───────────────┘
│           └─ connectOverCDP() ───────┼──────────┘
│                                      │
│  数据流：                             │
│  FDA页面 → API列表 → 临床试验搜索     │
│  → 客户匹配 → CSP推荐 → MD报告       │
└──────────────────────────────────────┘
```

- **Pi** 是大脑：读取 SKILL.md 指令，自主规划并执行
- **browser.js** 是手：通过 `BROWSER_ENDPOINT` 连接远程 browserless，在真实 Chromium 中操作网页
- **browserless** 是外部浏览器服务：Docker 镜像不含 Chromium，通过 WebSocket 连接
- **scenarios/** 是业务逻辑：每个场景一个独立 Skill，可插拔

## 前置要求

- **Docker** + **Docker Compose**（推荐 Docker 24+）
- **DashScope API Key**：在 [阿里云百炼](https://bailian.console.aliyun.com/) 控制台创建，模型包括 qwen3.7-max、deepseek-v4-pro、glm-5.2、kimi-k2.6 等
- **Browserless 服务**：独立部署的 browserless（用于浏览器自动化，Docker 镜像不含 Chromium，通过 WebSocket 连接远程 browserless）
- **网络**：Docker 容器需能访问 `dashscope.aliyuncs.com`、`fda.gov`、`chinadrugtrials.org.cn`，以及 browserless 服务地址

## 快速开始

```bash
# 1. 克隆仓库
git clone https://github.com/jordan2330/pi_csp_agent.git
cd pi_csp_agent

# 2. 配置环境变量
cp .env.example .env
nano .env
# 填入：
#   DASHSCOPE_API_KEY=sk-你的key
#   BROWSER_ENDPOINT=ws://your-browserless:3000/?token=xxx&headless=false
#   # headless=false 让浏览器在 VNC 中可见（调试推荐）

# 3. 构建镜像（瘦身后不含 Chromium，构建较快）
docker compose build

# 4. 创建 pi-home 目录（容器内 piuser 的 HOME，首次运行需要）
mkdir -p pi-home

# 5. 启动交互模式
docker compose run --rm csp-agent

# 6. 在 Pi TUI 中执行
/model qwen3.7-max          # 选择模型
/lead-scan nitrosamine      # 启动商机发掘
```

## 运行模式

### 自动无头运行（生产用，推荐）

```bash
# 增量模式（默认）：只搜索新 API，几分钟完成
docker compose run --rm csp-agent -p "/lead-scan nitrosamine"

# 全量模式：先改配置，再运行（约 2-3 小时）
echo '{"search_mode": "full"}' > config/search-config.json
docker compose run --rm csp-agent -p "/lead-scan nitrosamine"
```

`-p` 模式（headless）下 Pi 不启动 TUI，直接执行 prompt 并退出。

**执行流程**：
1. Agent 读取 `search-config.json` 确认模式
2. Agent 检查 FDA 缓存（有则跳过采集）
3. Agent 调用 `scripts/run-pipeline.js` 自动完成搜索+报告
4. Agent 输出结果摘要后退出

### 交互式调试（开发用）

```bash
docker compose run --rm csp-agent
```

进入 Pi TUI 后可以：
- `/model qwen3.7-max` — 切换模型
- `/lead-scan nitrosamine` — 执行完整 pipeline
- 随时按 `Enter` 发送 steering 消息干预 Agent 行为
- 遇到验证码时 Agent 会暂停并说明情况，等待你的指示

## 查看产出物

```bash
# 主报告 — 销售直接看的 Markdown 文件
cat output/CSP_Leads_Report.md

# 运行快照 — 每次运行的完整数据，用于增量对比
ls output/runs/

# FDA 缓存 — 每次运行自动刷新
cat config/fda_nitrosamines.json | python3 -m json.tool | head -20
```

报告结构：
- **概览**：API 数量、临床试验数量、按风险等级分布、数据源分布、**剂型分布统计**
- **新增商机**：本次运行新发现的客户（最前面），含产品名称、剂型和药物分类
- **全量列表**：按 FDA Potency Cat 1→5 分组，每个API含：
  - **产品名称**：CDT 来源显示中文商品名（如“西格列汀二甲双胍缓释片”），CT.gov 来源显示英文干预名称（如“Sitagliptin 100mg”）
  - **剂型**：口服固体制剂(片剂/胶囊)、改良释放制剂、吸入制剂、注射制剂等；⭐口服固体加粗高亮
  - **企业联系方式**：联系人、电话、邮箱、地址（CDT + CT.gov 双源均有）
  - **药物分类**：仿制药/原研药/新药/新药（改良型）
  - **来源标注**：CDT（含联系方式）或 CT.gov（含联系方式）

### 全量搜索（首次部署）

首次上线时需要全量搜索所有 API 在两个数据源上的试验数据。编辑 `config/search-config.json`：

```bash
# 改为全量模式
nano config/search-config.json
# 将 "search_mode" 改为 "full"

# 执行扫描
docker compose run --rm csp-agent -p "/lead-scan nitrosamine"
```

全量搜索完成后会自动将 `search_mode` 改回 `"incremental"`。之后的日常运行只搜索新增/未完成的 API。

### 双源搜索机制

每个 API 必须在两个数据源都搜索过：
- **chinadrugtrials.org.cn**（主源）：用 API 中文名搜索，提取：
  - 产品名称（中文商品名，如“西格列汀二甲双胍缓释片”）
  - **剂型**（从中文后缀自动识别：片/胶囊/缓释/吸入/注射等，识别率 97%）
  - 企业联系方式（联系人/电话/邮箱/地址）
- **ClinicalTrials.gov**（辅源）：用英文名+China限定，提取：
  - 产品名称（从 Intervention 字段匹配，提取率 81%）
  - **剂型**（从 Intervention.description + Title 关键词推断，提取率 31%）
  - 联系方式（centralContacts + Location.contacts，提取率 80%）

两个来源独立跟踪搜索状态，互不影响。详见 `config/fda_nitrosamines.json` 中的 `searched_cdt` / `searched_ctgov` 字段。

**CSP 重点关注剂型**：口服固体制剂（片剂/胶囊/颗粒）和改良释放制剂，报告中用 ⭐ 加粗高亮。

## 定时任务

每周一早上 8 点自动运行：

```bash
crontab -e
```

添加：
```cron
0 8 * * 1 cd /home/$USER/pi_csp_agent && docker compose run --rm csp-agent -p "/lead-scan nitrosamine" >> output/cron.log 2>&1
```

> **文件权限**：容器以宿主机 UID 运行（通过 `entrypoint.sh` + `gosu`），生成的文件自动归属宿主机用户，无需手动 `chown`。

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
| 依赖外部 browserless | Docker 镜像不含 Chromium，通过 `BROWSER_ENDPOINT` 连远程 browserless | 确保 browserless 服务可用；本地开发可不设 `BROWSER_ENDPOINT`（需本地 Chromium） |
| VNC 看不到浏览器 | browserless 默认 headless 模式 | `.env` 中 `BROWSER_ENDPOINT` URL 加 `&headless=false` |
| 网站反爬 | chinadrugtrials 可能有验证码 | browser.js 已内置反检测 + browserless stealth；首次运行建议交互模式观察 |
| CSS 选择器失效 | 网站改版导致选择器不匹配 | SKILL.md 选择器已于 2026-07-12 实测验证；如失效先用 screenshot 模式分析 |
| 文件权限 | 容器以宿主机 UID 运行 | `entrypoint.sh` 自动处理，无需手动 chown |
| FDA 季度更新 | FDA 页面每季度更新一次 | Agent 每次运行自动刷新，无需手动干预 |

## 故障排除

### `docker compose run` 报 API key 错误

检查 `.env` 文件是否存在且内容正确：
```bash
cat .env
# 应输出：
# DASHSCOPE_API_KEY=sk-...
# BROWSER_ENDPOINT=ws://...
```

### browserless 连接失败 / VNC 看不到浏览器

1. 检查 `.env` 中 `BROWSER_ENDPOINT` 是否设置：
   ```bash
   grep BROWSER_ENDPOINT .env
   ```
2. 测试 browserless 是否可达：
   ```bash
   curl "http://your-browserless:3000/json/version?token=xxx"
   # 应返回 Chrome 版本信息 JSON
   ```
3. VNC 看不到浏览器窗口？在 `BROWSER_ENDPOINT` URL 后加 `&headless=false`
4. 在容器内测试连接：
   ```bash
   docker compose run --rm csp-agent bash -c 'echo $BROWSER_ENDPOINT'
   # 如果输出为空，说明 .env 未被 docker-compose 读取
   ```

### Pi TUI 中 `/lead-scan` 命令不存在

确认 `.pi/settings.json` 配置正确：
```bash
cat .pi/settings.json
# 应包含 "prompts": ["prompts/"]
```

### scripts/ 目录说明

`scripts/` 目录包含运维脚本，已纳入版本控制：
- `run-pipeline.js` — **主入口**（Agent 自动调用）：场景感知的瘦编排器，串联 CT.gov→CDT→快照→报告
- `reset-and-search.sh` — 从零全量重置（清缓存 + 双源重扫 + 报告），用法 `bash scripts/reset-and-search.sh nitrosamine`
- `lib/` — 通用层（跨场景复用）：
  - `sources.js` — CT.gov REST API 采集 + CDT 浏览器采集
  - `enrichment.js` — 剂型检测（中英文）、产品名抽取
  - `snapshot.js` — 运行快照 + 增量检测
  - `report.js` — 通用报告渲染器（由场景的 `scenario.json` + `enrich.js` 驱动）

### browser.js 报 `MODULE_NOT_FOUND: playwright`

Docker 镜像未正确构建。重新构建：
```bash
docker compose build --no-cache
```

### chinadrugtrials 搜索结果为空

1. 确认 browserless 连接正常（见上“browserless 连接失败”）
2. 用截图模式检查页面是否正常加载：
   ```bash
   docker compose run --rm csp-agent bash -c "node skills/browser_executor/scripts/browser.js screenshot https://www.chinadrugtrials.org.cn/clinicaltrials.searchlist.dhtml /tmp/test.png"
   ```
3. 如果页面正常但搜索无结果，检查搜索词是否为中文（`name_cn`），英文搜索可能无效
4. chinadrugtrials 搜索使用专用脚本 `cdt-search.js`，自动处理搜索/翻页/详情提取：
   ```bash
   docker compose run --rm csp-agent bash -c 'node skills/browser_executor/scripts/cdt-search.js "阿替洛尔" /tmp/test.json --max-details 5'
   ```

## 项目结构

```
pi-csp-agent/
├── Dockerfile, docker-compose.yml, .env.example
├── AGENTS.md                          # Pi 项目指令（Agent 启动时自动加载）
├── .pi/settings.json                  # Pi 配置：skills/prompts 路径
├── config/
│   ├── models.json                    # Qwen 模型配置
│   ├── api_translations.json          # API 中英对照表（104对，来源USP参考文件）
│   ├── fda_nitrosamines.json          # FDA 数据缓存（双源搜索状态机，自动生成）
│   └── search-config.json             # 搜索模式配置（full/incremental）
├── skills/browser_executor/
│   ├── SKILL.md                       # 浏览器工具使用说明（含 select/evaluate/loop/delay action）
│   └── scripts/
│       ├── browser.js                 # Playwright 自动化脚本（双模式：本地 launch 或远程 connectOverCDP）
│       └── cdt-search.js              # chinadrugtrials.org.cn 专用搜索脚本（搜索+翻页+详情提取）
├── scenarios/nitrosamine/
│   ├── SKILL.md                       # 亚硝胺场景 pipeline（编排器，调用 scripts/ 执行）
│   ├── scenario.json                  # 场景声明式配置（标题/表头列/CSP矩阵/缓存路径）
│   ├── enrich.js                     # 场景专属 hooks（药物分类/CSP推荐/报告小标题）
│   └── references/csp-recommendations.md  # CSP 产品推荐规则
├── scripts/                           # 运维脚本（Agent 自动调用，已纳入版本控制）
│   ├── run-pipeline.js                # ★ 主入口：场景感知瘦编排器（CT.gov + CDT + 报告）
│   ├── reset-and-search.sh            # 从零全量重置脚本
│   └── lib/                           # 通用层（跨场景复用）
│       ├── sources.js                 # CT.gov REST + CDT 浏览器采集
│       ├── enrichment.js              # 剂型检测 / 产品名抽取
│       ├── snapshot.js                # 快照 + 增量检测
│       └── report.js                  # 通用报告渲染器
├── prompts/lead-scan.md               # 入口命令 /lead-scan <scenario>
├── pi-home/                           # 容器内 piuser 的 HOME（自动生成，已 gitignore）
└── output/
    ├── CSP_Leads_Report.md            # 商机报告
    └── runs/                          # 运行快照（增量对比用）
```

> **注意**：Docker 镜像不含 Chromium（已瘦身），浏览器自动化通过 `BROWSER_ENDPOINT` 环境变量连接外部 browserless 服务。

## License

MIT
