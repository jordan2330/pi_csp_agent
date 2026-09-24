# Pi CSP Agent — 亚硝胺商机发掘

> ✅ **当前稳定基线：`v3.3-stable`**（代码 v3.3.4，2026-09-23）—— 版本索引与标记约定见 [CHANGELOG.md](CHANGELOG.md)

基于 [Pi Coding Agent](https://pi.dev) 的 CSP（Aptar 活性包装）销售商机自动发掘系统。Agent 自动抓取 FDA 亚硝胺杂质风险 API 列表，逐一在中国药物临床试验登记平台搜索相关临床试验，匹配客户画像并生成包含 CSP 产品推荐的 Markdown 商机报告。

## 架构概览

```
┌────────────── WSL (Ubuntu 22) ──────────────   ┌──────────── Windows ────────────┐
│  Pi (Qwen LLM)                              │   │  真实 Chrome 153                │
│  ├─ prompts/lead-scan.md       入口命令      │   │  (专用 profile: C:\cdt-profile, │
│  ├─ scenarios/nitrosamine/     场景指令      │CDP│   CDP 端口 9223)                │──→ FDA
│  ─ skills/browser_executor/   浏览器自动化  │──→│                                │──→ chinadrugtrials
│       └─ cdt-search-lib.js + browser.js     │   │  真实指纹 → 能过瑞数质询         │──→ ClinicalTrials.gov
│                                             │   └────────────────────────────────
│  数据流: FDA页面 → API列表 → 双源试验搜索     │            ↑
│         → 客户匹配 → CSP推荐 → Markdown报告   │    mirrored 网络模式
└─────────────────────────────────────────────┘   (WSL 可访问 Windows 的 127.0.0.1)
```

- **Pi** 是大脑：读取 SKILL.md 指令，自主规划并执行
- **cdt-search-lib.js / browser.js** 是手：通过 CDP 连接 Windows 侧真实 Chrome 操作网页（端点由 `scripts/browser-connect.js` 解析）
- **为什么必须真浏览器**：chinadrugtrials 已启用瑞数动态安全（JS 质询 + 浏览器指纹检测），headless/自动化浏览器会被拦截；早期用远程 browserless（机房 IP + 自动化指纹）已被封禁
- **scenarios/** 是业务逻辑：每个场景一个独立 Skill，可插拔

## 前置要求

- **WSL2 (Ubuntu 22.04)** + **Windows 11 22H2+**（mirrored 网络模式的要求）
- **Node.js 20+**（当前开发环境 v24）
- **Windows 侧 Google Chrome**：CDT 反爬（瑞数动态安全）必须用真实浏览器，headless 会被拦截
- **DashScope API Key**：在 [阿里云百炼](https://bailian.console.aliyun.com/) 创建，模型包括 qwen3.7-max、deepseek-v4-pro、glm-5.2、kimi-k2.6 等
- **网络**：需能访问 `dashscope.aliyuncs.com`、`fda.gov`、`chinadrugtrials.org.cn`、`clinicaltrials.gov`
- **一次性配置**：`C:\Users\<你>\.wslconfig` 加入 `networkingMode=mirrored`，然后 `wsl --shutdown` 重启（让 WSL 能访问 Windows 的 `127.0.0.1:9223`）

## 快速开始

```bash
# 1. 克隆仓库
git clone https://github.com/jordan2330/pi_csp_agent.git
cd pi_csp_agent

# 2. 安装依赖（只装 playwright 库，不下载浏览器 —— 浏览器用 Windows 上的 Chrome）
cd skills/browser_executor/scripts && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i && cd ../../..

# 3. 启动 Windows 侧真实 Chrome（专用 profile + CDP 端口 9223；已在运行则秒退）
bash scripts/launch-chrome.sh

# 4. 配置模型
mkdir -p ~/.pi/agent && cp config/models.json ~/.pi/agent/models.json
export DASHSCOPE_API_KEY=sk-你的key        # 建议写入 ~/.bashrc

# 5. 启动 Pi
pi                                        # 交互模式
/model qwen3.7-max                        # 选择模型
/lead-scan nitrosamine                    # 启动商机发掘
```

> 脚本默认连接 `http://127.0.0.1:9223`（Windows Chrome 的 CDP 端点）。需要指向其他端点（如远程 browserless）时设置 `BROWSER_ENDPOINT=http://...` 或 `ws://...`。

## 运行模式

### 非交互运行（生产/定时用）

```bash
# 增量模式（默认）：只搜索新 API，通常几十分钟
pi -p "/lead-scan nitrosamine"

# 全量模式：先改配置，再运行（约 3-4 小时）
echo '{"search_mode": "full"}' > config/search-config.json
pi -p "/lead-scan nitrosamine"
```

`-p` 模式（非交互）下 Pi 不启动 TUI，直接执行 prompt 并退出。

**执行流程**：
1. Agent 读取 `search-config.json` 确认模式
2. Agent 确认 Chrome CDP 端点可用（不通则运行 `bash scripts/launch-chrome.sh`）
3. Agent 检查 FDA 缓存（有则跳过采集）
4. Agent 调用 `scripts/run-pipeline.js` 自动完成搜索+报告
5. Agent 输出结果摘要后退出

### 交互式调试（开发用）

```bash
pi
```

进入 Pi TUI 后可以：
- `/model qwen3.7-max` — 切换模型
- `/lead-scan nitrosamine` — 执行完整 pipeline
- 随时按 `Enter` 发送 steering 消息干预 Agent 行为
- 瑞数质询在真浏览器下自动通过；如遇验证码，可在 Chrome 窗口手动处理后让 Agent 继续

## 查看产出物

```bash
# 主交付物 — 销售用的 Excel（OSD 优先分组 + 自动筛选 + 可透视）
ls -la output/CSP_Leads_Report.xlsx


# Markdown — 文本存档（pi 读它做摘要）
cat output/CSP_Leads_Report.md

# 运行快照 — 每次运行的完整数据，用于增量对比
ls output/runs/

# FDA 缓存 — 每次运行自动刷新
cat config/fda_nitrosamines.json | python3 -m json.tool | head -20
```

### Excel 结构（主交付物）

| Sheet | 内容 | 用法 |
|---|---|---|
| 概览 | 统计 + 优先级说明 + **数据局限** | 先看这张 |
| P1-口服固体 | OSD（含改良释放/颗粒散剂），**按 AI limit Cat 1→5 分段**，段内企业数降序、进行中试验优先 | 销售主战场：Cat 1 排最前 |
| P2-其他剂型 | 非 OSD，同样按 Cat 分段 | 次优先 |
| 全部商机 | 扁平表（**一行 = 一条试验，已按登记号去重**，23 列） | 数据透视 / 图表 |
| 按API汇总 | 一行 = 一个 API（试验数/企业数/OSD 数/推荐方案） | 管理视角 |

**优先度**：OSD+Cat1 → OSD+Cat2/3/4/5 → 其他剂型+Cat1/2/3/4/5（Sheet 顺序即优先级）。

**去重与关联**：同一试验若命中多个 API（如复方制剂），只出一行，用「涉及API(含Cat)」列列出全部关联 API，**风险等级取其中最高**（Cat 数最小）。

**药物分类口径**：分类按**产品级**统一（同一产品名只要有一次 BE/一致性评价证据 → 全部记为仿制药；非原研企业的上市后 IV 期试验亦记为仿制药），避免同药多口径。
需要「OSD+Cat1」单独视图？在 P1 sheet 用「风险等级」列筛选即可（首行已开自动筛选），不需要拆成 10 张 sheet。

**CSP 推荐方案按剂型给出候选组合**（依据 CSP 产品选型准则：**包装形态优先**），例如：

| 剂型 | 候选方案 | 待确认 |
|---|---|---|
| 口服固体制剂(片剂/胶囊) | Activ-Blister®（泡罩线）/ Activ-Vial®（瓶装线） | 包装形态 |
| 改良释放制剂 | Activ-Blister® / 3-Phase Activ-Polymer™ | 包装形态 |
| 颗粒/散剂 | Activ-Sachet® / Activ-Film® | 包装形态 |
| 透皮贴剂/柔性包装 | Activ-Film® | 包装形态 |
| 注射/气雾剂 | 标注「低相关/需评估」，不再硬塞产品 | — |

**报告字段**：涉及API、分类依据（官方证据(CDE)/搜索证据/规则推断，标明标签可信度）、注册分类（1类创新/2类改良/3-4类仿制）、一致性评价（过评=已上市仿制、有真实产能）、证据来源、产品名称（CDT 中文商品名 / CT.gov 干预名）、剂型（⭐口服固体加粗）、药物分类（仿制药/原研药/新药/新药（改良型）/观察性研究）、企业联系方式（联系人/电话/邮箱/地址）、试验状态、登记号与日期、来源（CDT/CT.gov）、本次是否新增。

**模式差异**：增量模式下两个交付物（xlsx/md）**都只含新增商机**（Excel sheet 名带 `新增-` 前缀）；全量模式才含完整列表。

### 全量搜索（首次部署）

首次上线时需要全量搜索所有 API 在两个数据源上的试验数据。编辑 `config/search-config.json`：

```bash
# 改为全量模式
nano config/search-config.json
# 将 "search_mode" 改为 "full"

# 检查 Chrome 端点后执行扫描（约 3-4 小时，建议用 systemd-run 托管）
bash scripts/launch-chrome.sh
node scripts/run-pipeline.js nitrosamine
```

全量搜索完成后会自动将 `search_mode` 改回 `"incremental"`。之后的日常运行每次仍遍历全部 API，但只增量拉取新增数据（CT.gov 全拉并与缓存对比，CDT 用 `last_cdt_regno` 游标续搜）。

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

两个来源独立跟踪搜索状态，互不影响。CDT 增量的游标在 `config/fda_nitrosamines.json` 每 API 的 `last_cdt_regno` 字段中（登记号最大值，空串表示待全量）；CT.gov 不存游标，每次全量拉取后与缓存中的 NCT ID 对比检测新增。

**CSP 重点关注剂型**：口服固体制剂（片剂/胶囊/颗粒）和改良释放制剂，报告中用 ⭐ 加粗高亮。

## 定时任务

每周一早上 8 点自动运行（WSL 内 crontab）：

```cron
0 8 * * 1 cd $HOME/pi_csp_agent && bash scripts/launch-chrome.sh && node scripts/run-pipeline.js nitrosamine >> output/runs/cron.log 2>&1
```

> 长任务（全量 3-4 小时）建议用 `systemd-run --user --unit=csp-scan ...` 托管，并先执行 `loginctl enable-linger $USER`，避免会话结束后被回收（详见 `scenarios/nitrosamine/SKILL.md`）。

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
| 依赖 Windows Chrome | 必须用真实浏览器才能过瑞数质询 | 运行前执行 `bash scripts/launch-chrome.sh`；pipeline 也会自动尝试拉起 |
| 需要 mirrored 网络 | WSL 默认 NAT 模式访问不到 Windows 的 `127.0.0.1` | `.wslconfig` 设 `networkingMode=mirrored`；若与其他工具冲突可改回 NAT 并用 `BROWSER_ENDPOINT` 指向别处 |
| 单 worker 较慢 | CDT 反爬下采用单线程低频（`CDT_WORKER_COUNT = 1`） | 全量约 3-4 小时；增量通常几十分钟 |
| 网站反爬 | chinadrugtrials 启用瑞数动态安全：JS 质询 + 指纹检测 | 真浏览器 + 不注入伪造指纹 + 低频；如遇临时限流，等一段时间再跑 |
| CSS 选择器失效 | 网站改版导致选择器不匹配 | SKILL.md 选择器已于 2026-07-12 实测验证；如失效先用 screenshot 模式分析 |
| FDA 季度更新 | FDA 页面每季度更新一次 | Agent 每次运行自动刷新，无需手动干预 |

## 故障排除

### 连不上 Chrome / CDP 端点

1. 检查端点：
   ```bash
   curl -s http://127.0.0.1:9223/json/version | head -3
   # 应返回 {"Browser": "Chrome/15x...", ...}
   ```
2. 无输出 → 启动 Chrome：`bash scripts/launch-chrome.sh`（自动找 Chrome 路径、启动、等待端点就绪）
3. 仍失败：
   - 确认 `~/.wslconfig` 里有 `networkingMode=mirrored`，且重启过 WSL
   - 确认该专用 profile 没有已存在的 Chrome 窗口在运行（同 profile 会复用进程，调试端口失效）
4. 指向自定义端点：`export BROWSER_ENDPOINT=http://127.0.0.1:9223`

### Pi TUI 中 `/lead-scan` 命令不存在

确认 `.pi/settings.json` 配置正确：
```bash
cat .pi/settings.json
# 应包含 "prompts": ["prompts/"]
```

### scripts/ 目录说明

`scripts/` 目录包含运维脚本，已纳入版本控制：
- `run-pipeline.js` — **主入口**（Agent 自动调用）：场景感知的瘦编排器，串联 CT.gov→CDT→CDE分类富化→快照→报告
- `launch-chrome.sh` — 启动 Windows 侧真实 Chrome（专用 profile + CDP 端口 9223），pipeline 会在端点不可用时自动调用
- `reset-and-search.sh` — 从零全量重置（清缓存 + 双源重扫 + 报告），用法 `bash scripts/reset-and-search.sh nitrosamine`
- `lib/` — 通用层（跨场景复用）：
  - `sources.js` — CT.gov REST API 采集 + CDT 浏览器采集
  - `enrichment.js` — 剂型检测（中英文）、产品名抽取
  - `snapshot.js` — 运行快照 + 增量检测
  - `report.js` — 通用报告渲染器（由场景的 `scenario.json` + `enrich.js` 驱动）

### browser.js 报 `MODULE_NOT_FOUND: playwright`

依赖未安装。执行：
```bash
cd skills/browser_executor/scripts
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i
```

### chinadrugtrials 搜索结果为空

1. 确认 Chrome CDP 正常（见上「连不上 Chrome / CDP 端点」）
2. 用截图模式检查页面是否正常加载：
   ```bash
   node skills/browser_executor/scripts/browser.js screenshot https://www.chinadrugtrials.org.cn/clinicaltrials.searchlist.dhtml /tmp/test.png
   ```
3. 截图为空白/质询页 → 浏览器指纹或 IP 被风控，等一段时间或降低频率后重试
4. 页面正常但搜索无结果 → 确认搜索词是中文名（`name_cn`），英文名在 CDT 无效
5. 单独验证单个 API 的采集：
   ```bash
   node skills/browser_executor/scripts/cdt-search.js "阿替洛尔" /tmp/test.json --max-details 5
   ```

## 项目结构

```
pi-csp-agent/
├── AGENTS.md                          # Pi 项目指令（Agent 启动时自动加载）
├── .pi/settings.json                  # Pi 配置：skills/prompts 路径
├── config/
│   ├── models.json                    # Qwen 模型配置（复制到 ~/.pi/agent/models.json）
│   ├── api_translations.json          # API 中英对照表（104对，来源USP参考文件）
│   ├── cdt-throttle.json              # CDT 请求节奏控制
│   ├── cde-classify.json              # CDE 官方受理品种信息采集配置（分类富化主源）
│   ├── fda_nitrosamines.json          # FDA 数据缓存（双源搜索状态机，自动生成）
│   └── search-config.json             # 搜索模式配置（full/incremental）
├── skills/browser_executor/
│   ├── SKILL.md                       # 浏览器工具说明（连接模式/action/安全约束）
│   └── scripts/
│       ├── browser-connect.js         # 连接解析：真浏览器 CDP 优先，自动拉起 Chrome
│       ├── browser.js                 # 多步脚本执行器（script/screenshot 模式）
│       ├── cdt-search-lib.js          # CDT 搜索核心库（pipeline 直接 require）
│       └── cdt-search.js              # CDT 搜索 CLI 包装（调试用）
├── scenarios/nitrosamine/
│   ├── SKILL.md                       # 亚硝胺场景 pipeline（编排器，调用 scripts/ 执行）
│   ├── scenario.json                  # 场景声明式配置（标题/表头列/CSP矩阵/缓存路径）
│   ├── enrich.js                      # 场景专属 hooks（药物分类/CSP推荐/报告小标题）
│   └── references/csp-recommendations.md  # CSP 产品推荐规则
├── scripts/                           # 运维脚本（Agent 自动调用，已纳入版本控制）
│   ├── run-pipeline.js                # ★ 主入口：场景感知瘦编排器（CT.gov + CDT + 报告）
│   ├── launch-chrome.sh               # 启动 Windows 侧真实 Chrome（CDP 9223）
│   ├── reset-and-search.sh            # 从零全量重置脚本
│   └── lib/                           # 通用层（跨场景复用）
│       ├── sources.js                 # CT.gov REST + CDT 浏览器采集
│       ├── cde-classify.js            # CDE 受理品种信息 → 注册分类证据（官方一手，免费）
│       ├── enrichment.js              # 剂型检测 / 产品名抽取
│       ├── snapshot.js                # 快照 + 增量检测
│       ├── report.js                  # Markdown 渲染器
│       └── report-xlsx.js             # Excel(5 sheet) 渲染器
├── prompts/lead-scan.md               # 入口命令 /lead-scan <scenario>
└── output/
    ├── CSP_Leads_Report.md            # 商机报告
    └── runs/                          # 运行快照（增量对比用）
```

> **本地运行说明**：不再使用 Docker。采集依赖 Windows 侧真实 Chrome（专用 profile，CDP 端口 9223），WSL 需 mirrored 网络模式；端点可用 `BROWSER_ENDPOINT` 覆盖。

## License

MIT
