# Pi CSP Agent — 亚硝胺商机发掘

> ✅ **当前稳定基线：以 [CHANGELOG.md](CHANGELOG.md)「当前稳定基线」为准**（现为 v5.1.1；v5.2.0 环境隔离待生产验证）
> （开发单线在 `master` 上进行，master 即正式版；Excel 交付时代（v4.2-stable）仅存 tag）

基于 [Pi Coding Agent](https://pi.dev) 的 CSP（Aptar 活性包装）销售商机自动发掘系统。Agent 自动抓取 FDA 亚硝胺杂质风险 API 列表，逐一在中国药物临床试验登记平台搜索相关临床试验，匹配客户画像，同步到**企微智能表格**（含 CSP 产品推荐与销售反馈回路）。

## 日常只需要这三条

```bash
git pull                              # 生产机：拉最新代码
node scripts/wecom-sync.js status     # 看表现在怎么样（只读，随时可跑）
node scripts/wecom-sync.js reorder    # 只有改了字段/顺序才跑（破坏性：删字段重建，反馈自动备份回写）
```

其余全自动：定时任务只跑 `node scripts/run-pipeline.js nitrosamine`（内部调 `sync`）。
**`init` 只用两件事**：第一次建表、换机补章。开发机隔离见「多机部署 / 换机迁移 → 环境隔离」。

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
│         → 客户匹配 → CSP推荐 → 分类富化       │    mirrored 网络模式
│         → 企微智能表格（销售反馈回流）          │ (WSL 可访问 Windows 的 127.0.0.1)
└─────────────────────────────────────────────┘
```

- **Pi** 是大脑：读取 SKILL.md 指令，自主规划并执行
- **cdt-search-lib.js / browser.js** 是手：通过 CDP 连接 Windows 侧真实 Chrome 操作网页（端点由 `scripts/browser-connect.js` 解析）
- **为什么必须真浏览器**：chinadrugtrials 已启用瑞数动态安全（JS 质询 + 浏览器指纹检测），headless/自动化浏览器会被拦截；早期用远程 browserless（机房 IP + 自动化指纹）已被封禁
- **scenarios/** 是业务逻辑：每个场景一个独立 Skill，可插拔
- **企微智能表格**是唯一交付**形态**（v5.0.0 起）：pipeline 同步；销售在同一链接看到最新线索并填跟进反馈（状态/负责人/备注）→ 每次同步回流 feedback.json 账本。**每场景一张表**（「CSP商机跟踪」为主表；管线场景另建「CSP管线商机」，不复用现有 37 列，见下「管线场景」）

## 前置要求

- **WSL2 (Ubuntu 22.04)** + **Windows 11 22H2+**（mirrored 网络模式的要求）
- **Node.js 20+**（当前开发环境 v24）
- **Windows 侧 Google Chrome**：CDT 反爬（瑞数动态安全）必须用真实浏览器，headless 会被拦截
- **DashScope API Key**（**仅 pi 交互/开发需要；生产定时任务不需要**）：在 [阿里云百炼](https://bailian.console.aliyun.com/) 创建，模型包括 qwen3.7-max、deepseek-v4-pro、glm-5.2、kimi-k2.6 等
- **企微自建应用（交付物需要，管理员权限）**：① 企业ID + 应用 Secret；② 管理后台「协作 → 文档 → API」把应用加入可调用列表；③ 应用详情页「企业可信IP」加入运行机出口 IPv4（出口 IP 变了报 60020，跑 `node scripts/wecom-sync.js checkip` 查新 IP 加白名单）
- **网络**：需能访问 `dashscope.aliyuncs.com`、`fda.gov`、`chinadrugtrials.org.cn`、`clinicaltrials.gov`、`qyapi.weixin.qq.com`
- **一次性配置**：`C:\Users\<你>\.wslconfig` 加入 `networkingMode=mirrored`，然后 `wsl --shutdown` 重启（让 WSL 能访问 Windows 的 `127.0.0.1:9223`）

## 快速开始

```bash
# 1. 克隆仓库（默认分支 master = 当前稳定基线，版本以 CHANGELOG.md「当前稳定基线」为准）
git clone https://github.com/jordan2330/pi_csp_agent.git
cd pi_csp_agent

# 2. 安装依赖（只装 playwright 库，不下载浏览器 —— 浏览器用 Windows 上的 Chrome）
cd skills/browser_executor/scripts && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i && cd ../../..

# 3. 启动 Windows 侧真实 Chrome（专用 profile + CDP 端口 9223；已在运行则秒退）
bash scripts/launch-chrome.sh

# 4. 配置模型（LLM；仅交互/开发用，纯生产定时任务可跳过）
mkdir -p ~/.pi/agent && cp config/models.json ~/.pi/agent/models.json
export DASHSCOPE_API_KEY=sk-你的key        # 建议写入 ~/.bashrc

# 5. 配置企微（交付物：智能表格）
cp .env.example .env                       # 填 WECOM_CORPID / WECOM_SECRET（+可选 WECOM_WEBHOOK_KEY）
node scripts/wecom-sync.js init            # 创建智能表格（首次部署）
# 换机/接入已有表见下方「多机部署」—— 绝不能在已有表的机器外盲跑 init

# 6. 启动 Pi
pi                                        # 交互模式
/model qwen3.7-max                        # 选择模型
/lead-scan nitrosamine                    # 启动商机发掘（首跑为全量，约 3-4 小时）
```

> 脚本默认连接 `http://127.0.0.1:9223`（Windows Chrome 的 CDP 端点）。需要指向其他端点（如远程 browserless）时设置 `BROWSER_ENDPOINT=http://...` 或 `ws://...`。

## 多机部署 / 换机迁移

**关键：智能表格的 `docid` 存在本地 `config/wecom.json`（gitignore）**，销售数据和反馈都在这张表里。新机器**绝不能盲跑 `init`**（会创建第二张表，销售看不到）。两种接入方式任选：

```bash
# 方式 A（推荐）：从旧机器拷一个文件
#   scp 旧机:pi_csp_agent/config/wecom.json 新机:pi_csp_agent/config/wecom.json

# 方式 B：init 传参（docid 从旧机的 config/wecom.json 里读）
node scripts/wecom-sync.js init <docid> [url]
# 也可在 .env 里配 WECOM_DOCID=... WECOM_DOC_URL=... 后直接 node scripts/wecom-sync.js init
```

迁移清单（按需）：

| 文件 | 必拷? | 说明 |
|---|---|---|
| `.env` | **必** | 企微凭证（新旧机器各自配也行） |
| `config/wecom.json` | **必** | 表格 docid/sheet_id/url（或用方式 B）；**只拷到真正的生产机**（开发机应设在 dev 环境自己的表，见下节） |
| `config/fda_nitrosamines.json` | 建议 | 不拷则首跑重新采集 FDA 页（走 Phase 1）+ **CDT 全量重搜（3-4 小时）**；拷了则增量 |
| `output/history/ledger.json` | 建议 | 不拷则「首次发现」日期从新机首跑日重建 |
| `config/cde_class_cache.json` | 可选 | 不拷则 CDE 分类证据重查（免费接口，多几分钟） |
| 企业可信IP | **必（后台）** | 新机器出口 IP 需加入企微管理后台白名单 |

### 环境隔离（生产 / 开发）

交付层写哪张表由 `WECOM_ENV` 决定：缺省 `prod` → `config/wecom.json`；`dev` → `config/wecom.dev.json`（其他环境同理 `config/wecom.<env>.json`）。两张表互不可达——**刻意不做跨环境回退**。

```bash
# ① 生产机（一次性）：给已有 config/wecom.json 补上 env/host 盖章
node scripts/wecom-sync.js init        # 表已存在 → 只补章，不重建、不碰数据

# ② 开发机（一次性）：固定 dev 身份 + 建自己的测试表（表名为「CSP商机跟踪-dev」）
echo 'WECOM_ENV=dev' >> .env            # 不设 = prod，忘设就会直写生产表
WECOM_ENV=dev node scripts/wecom-sync.js init
```

误跑时的报错长这样（写入前拦下，不会碰到生产数据）：

```
❌ 拒绝写入（sync）：wecom.json 属于 env=prod，当前 WECOM_ENV=dev。
  → 用对应环境：WECOM_ENV=prod node scripts/wecom-sync.js sync
  → 或在本环境建自己的表：WECOM_ENV=dev node scripts/wecom-sync.js init
```

配置里的 `host` 也参与校验：把生产 `config/wecom.json` 拷到另一台机器后直接 `sync` 会被拒绝（目标表由主机「旧机」创建）。本机**确为新的生产机**时用 `WECOM_ADOPT=1 node scripts/wecom-sync.js init <docid>` 一次性接管；只读命令（`status` / `feedback` / `checkip`）不受任何拦截。

**群机器人通知同理只在 `prod` 发送**：dev/test 环境就算 `.env` 里带着同一个 `WECOM_WEBHOOK_KEY`（`scp` 来的），也会打一行「群通知已跳过」后不推 —— 否则开发机每跑一次就往销售群里发一次假「本次新增」。想测推送格式用 `node scripts/wecom-poc.js webhook`（手动、一次性）。

⚠️ **唯一残洞**：开发机上不设 `WECOM_ENV`，且生产机的 `config/wecom.json` 还没补章（v5.2.0 之后跑过一次 `init`）——此时开发机的 dev 身份无从识别，仍会写生产表。做法：生产机先跑一次 `init` 补章，开发机 `echo 'WECOM_ENV=dev' >> .env`。

## 运行模式

### 生产运行（定时/无人值守）—— 直接跑脚本，不需要 pi

```bash
# 增量模式（默认，通常 1 小时内）
bash scripts/launch-chrome.sh
node scripts/run-pipeline.js nitrosamine

# 全量模式（首次部署或需要重扫，约 3-4 小时）
echo '{"search_mode": "full"}' > config/search-config.json
node scripts/run-pipeline.js nitrosamine    # 完成后自动改回 incremental
```

pipeline 整条链路（CT.gov REST → CDT 浏览器采集 → CDE 富化 → 智能表格同步 → 群推送）**零 LLM 依赖**：不消耗 token、不需要 `DASHSCOPE_API_KEY`、不需要 pi。

前置只有一条：`config/fda_nitrosamines.json` 必须存在（首次部署用 `node scripts/fda-refresh.js` 生成；之后 FDA 页面季度性更新时同样一条命令刷新 —— 只改元信息，`results` 与 CDT 游标原样保留，不影响增量采集。页面改版导致解析失败时，按 SKILL.md Phase 1「退路」用浏览器提取）。

### 交互运行（开发 / 调试 / FDA 采集 / 页面改版适配）—— pi

```bash
pi
/model qwen3.7-max
/lead-scan nitrosamine
```

pi 的价值在流水线之外：
- **FDA 首次采集与刷新**（SKILL.md Phase 1：按页面结构生成 browser 采集脚本）
- **改版适配**：CDT/FDA 页面结构变化导致选择器失效时，交互式诊断 + screenshot 分析 + 修脚本
- **异常排查、开发迭代、数据问答**

> `/lead-scan` prompt 本质是让 Agent 按 SKILL.md 做前置检查 → 调 `run-pipeline.js` → 汇报结果。生产定时任务用它纯属多余（多一层 LLM 依赖与故障点）。

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
# 主交付物 — 企微智能表格「CSP商机跟踪」（同一链接，销售收藏后永远看到最新全量）
node scripts/wecom-sync.js status   # 表格链接 + 记录数 + 反馈统计
node scripts/wecom-sync.js feedback # 销售反馈账本摘要

# 运行快照 — 每次运行的完整数据，用于增量对比
ls output/runs/

# FDA 缓存 — 每次运行自动刷新
cat config/fda_nitrosamines.json | python3 -m json.tool | head -20
```

### 智能表格结构（主交付物，v5.0.0 起取代 Excel）

- **一行 = 一条商机**（“商机键”= 来源|登记号，已去重）；**表 = 窗口内活跃商机 ∪ 有反馈的线索**——出窗口且无反馈的自动移出表（本地账本留档全量；归档行无联系方式、对销售无价值）
- **字段顺序 = 销售阅读顺序**：分组/风险等级/★ → API → 企业/产品/联系人/电话 → CSP方案/分类/试验信息 → 反馈 4 列 → 溯源 → 系统列（最右）；重排用 `wecom-sync.js reorder`
- **销售反馈**：「跟进状态」（待跟进/跟进中/已联系/不感兴趣/已转化）+「负责人」（@人，自动通知）+「跟进备注」+「跟进日期」—— 销售独占写，pipeline 永不覆盖（`update_records` 字段级合并）；每次同步拉回，落 `output/history/feedback.json` 事件流（**有反馈的行永不出表**）
- **操作留痕**：表格内建「创建人/创建时间/最后编辑人/最后编辑时间」列自动记录谁何时改了哪行

**优先度**：P1（OSD）按 Cat 1→5 优先，其次 P2（其他剂型）同样分段。**分组与风险等级是两个独立列**，表内筛选/分组视图即可组合。

**去重与关联**：同一试验若命中多个 API（如复方制剂），只出一行，用「涉及API(含Cat)」列列出全部关联 API，**风险等级取其中最高**（Cat 数最小）。

**CSP 推荐方案按剂型给出候选组合**（依据 CSP 产品选型准则：**包装形态优先**），例如：

| 剂型 | 候选方案 | 待确认 |
|---|---|---|
| 口服固体制剂(片剂/胶囊) | Activ-Blister®（泡罩线）/ Activ-Vial®（瓶装线） | 包装形态 |
| 改良释放制剂 | Activ-Blister® / 3-Phase Activ-Polymer™ | 包装形态 |
| 颗粒/散剂 | Activ-Sachet® / Activ-Film® | 包装形态 |
| 透皮贴剂/柔性包装 | Activ-Film® | 包装形态 |
| 注射/气雾剂 | 标注「低相关/需评估」，不再硬塞产品 | — |

**报告字段**：★ 本次新增（checkbox）、首次发现（历史批次）、窗口状态（窗口内；已过窗口仅在有反馈的行出现）、涉及API、药物分类与注册分类（**只来自 CDE 官方受理记录，未取得证据留空、不做推断**）、分类依据（CDE 受理数据·产品级/品种级）、产品名称（CDT 中文商品名 / CT.gov 干预名）、剂型（⭐口服固体）、企业联系方式（联系人/电话/邮箱/地址）、试验状态、登记号（可点详情链接）、登记日期、来源（CDT/CT.gov）、跟进反馈 4 列。

**模式差异**：`search_mode` 只控制**数据抓取口径**（全量重搜 or 增量续搜），不影响交付范围——智能表格永远是**累积视图**（全量沉淀 + ★ 本次新增标识）。

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

## 管线场景（CSP管线商机）

第二个交付场景：**CDE 受理（化药 + 注册分类 1/2.x，排除进口 `J` 前缀受理号）→ 公司×资产 → 评分卡 → 企微第二张表「CSP管线商机」**。与亚硝胺共用浏览器采集与企微 API，但种子轴、行粒度、表、账本全独立，**不走 `run-pipeline.js`**。

```bash
node scenarios/pipeline/run.js                 # 日常：CDE 增量采集 → 期次 → 联系渠道 → 同步表
node scenarios/pipeline/run.js --dry-run       # 只算不写表（看会写多少行）
node scenarios/pipeline/run.js --skip-collect  # CDE 页面异常时：只富化 + 同步
node scenarios/pipeline/run.js --no-sync       # 只更新本地账本，不碰表
```

**账本是派生物，丢了要重采 1-2 小时**：`output/history/pipeline-cde.json`（gitignore 内）→ 打分 → 表。采集只在一台机器跑（两台各跑会口径漂移），上生产表/重采前先备一份：

```bash
cp output/history/pipeline-cde.json output/history/pipeline-cde.bak-$(date +%F).json
```

**表选择**：管线场景恒指向第二张表（`WECOM_TABLE=pipeline`）→ `config/wecom-pipeline.json`（prod）/ `config/wecom-pipeline.dev.json`（dev），与主表配置互不干扰，反馈账本独立为 `output/history/feedback-pipeline.json`。开发机 `.env` 必须是 `WECOM_ENV=dev`（不设即 prod，直写生产表）。首次建表 `node scenarios/pipeline/sync.js --init`；账本出现「同资产异写」导致表里重复行时，`node scenarios/pipeline/sync.js --dedupe` 合并并落盘。

**表内口径**：只放 A/B 档 ∪ 有反馈的行；`最近受理日 > 18 个月且无反馈` 自动移出（`PIPE_WINDOW_MONTHS` 可调），有反馈的行永不删。单步墙钟上限 30 分钟（`PIPE_STEP_TIMEOUT_MIN`），卡住的步骤被杀掉记失败，不会拖整晚。

定时（与主表并列，择一）：

```cron
17 7 * * * cd $HOME/pi_csp_agent && node scenarios/pipeline/run.js >> output/pipeline-cron.log 2>&1
```

> 状态：目前只在 **dev 表**验证过，**生产表尚未建立**；口径细节（`config/pipeline-scope.json` / 评分卡 / 里程碑）见 `scenarios/pipeline/SKILL.md`、`PLAN.md`。

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

### 企微 API 报 `60020 not allow to access from your ip`

出口 IP 不在企业可信IP白名单（家宽重拨/换网络后常见，**属正常现象**）：
```bash
node scripts/wecom-sync.js checkip   # 报错信息里直接给出该加的 IP
# → 管理后台：应用管理 → 应用 → 企业可信IP → 加上（分号分隔可多填，上限 120）
```

### 企微同步失败但 pipeline 未中断

Phase 3 同步失败只影响交付层（数据在本地快照里不丢）；修复凭证/白名单后手动补同步：
```bash
node scripts/wecom-sync.js sync      # 用最新快照重同步
```

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
│   ├── wecom-sync.js                  # 智能表格运维 CLI（init/status/feedback/checkip）
│   ├── wecom-poc.js                   # 企微 PoC 验证工具
│   └── lib/                           # 通用层（跨场景复用）
│       ├── sources.js                 # CT.gov REST + CDT 浏览器采集
│       ├── cde-classify.js            # CDE 受理品种信息 → 注册分类证据（官方一手，免费）
│       ├── enrichment.js              # 剂型检测 / 产品名抽取
│       ├── snapshot.js                # 快照 + 增量检测
│       ├── report.js                  # 数据模型（buildLeadModel + flattenTrials）
│       ├── wecom.js                   # 企微 API 客户端（智能表格 + 群机器人）
│       └── wecom-sheet.js             # 智能表格同步器（唯一交付层，37 字段）
├── prompts/lead-scan.md               # 入口命令 /lead-scan <scenario>
└── output/
    ├── history/                       # 账本（ledger/feedback/runs，gitignore 内）
    └── runs/                          # 运行快照（增量对比用）
```

> **本地运行说明**：不再使用 Docker。采集依赖 Windows 侧真实 Chrome（专用 profile，CDP 端口 9223），WSL 需 mirrored 网络模式；端点可用 `BROWSER_ENDPOINT` 覆盖。

## License

MIT
