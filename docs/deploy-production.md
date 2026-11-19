# 生产环境部署指南

> 适用对象：在新机器上从零把本系统跑起来，或把现有系统迁到新机器。
> 阅读顺序：按 §1→§9 依次执行；§10 之后是上线后的运维与故障处理。
> 相关文档：调度见 `docs/cron.md`，场景口径见 `scenarios/*/SKILL.md`，目录职责见 `AGENTS.md`。

---

## 0. 系统拓扑

```
┌───────────── Windows 11（宿主） ─────────────┐
│  Chrome 专用 profile（CDP 127.0.0.1:9223）    │
└───────────────────┬──────────────────────────┘
                    │ WSL mirrored 网络
┌───────────────────┴──────────────────────────┐
│  WSL2 Ubuntu                                  │
│   Node 22+  ── 采集/抽取/同步（无常驻服务）    │
│   Python3 + pdfminer（cninfo 公告 PDF）       │
│   crontab  ── 每日/每周触发                    │
└───────────────────┬──────────────────────────┘
                    │ HTTPS（企微 API / 巨潮 / 公众号 RSS / LLM）
                    ▼
        企微智能表格（交付）+ 群机器人（周报）
```

**没有任何常驻服务**：全部是 cron 触发的短进程，跑完退出。这是刻意的——出问题不会拖垮整机。

---

## 1. 前置条件

| 项 | 要求 | 怎么验 |
|---|---|---|
| 操作系统 | Windows 11 + WSL2 Ubuntu 22.04+ | `wsl -l -v` |
| 内存 | ≥ 8 GB（Chrome + Node 同时跑） | — |
| 磁盘 | ≥ 10 GB 空闲（账本 + 日志 + Chrome profile） | `df -h` |
| 网络 | 能访问 企微 API / cninfo / 公众号 RSS 服务 / DashScope；**WSL 能访问 Windows 的 127.0.0.1** | 见 §2.1 |
| 企微权限 | 自建应用的管理员权限（建应用、配可信 IP、加文档 API 权限） | — |
| LLM | 百炼（DashScope）API Key，模型 `deepseek-v4.1-flash-1017` | 见 §2.4 |
| sudo | 装 poppler / 系统包时需要 | — |

---

## 2. 系统与运行时

### 2.1 WSL 网络（必须 mirrored）

WSL 默认 NAT 模式下访问不到 Windows 的 `127.0.0.1`，而 Chrome CDP 就跑在那里。

```powershell
# Windows: C:\Users\<你>\.wslconfig
[wsl2]
networkingMode=mirrored
```

```bash
wsl --shutdown      # PowerShell 里执行，然后重开 WSL
```

验证（WSL 内）：

```bash
curl -s --max-time 5 http://127.0.0.1:9223/json/version | head -3
```

现在还没起 Chrome，**返回连接失败是正常的**，§2.3 之后再验。

### 2.2 Node（22 以上）

```bash
node -v            # 需要 v22+；本机实测 v22.23.4
```

记下绝对路径——**cron 的 PATH 里没有 node**：

```bash
command -v node    # 例：/home/<user>/.local/share/pi-node/current/bin/node
```

> 该项目 **零 npm 依赖**，不需要 `npm install`（`package.json` 的 `dependencies` 是空的）。
> `skills/browser_executor` 里的 playwright 只有调试用途，生产采集走 CDP，不依赖它。

### 2.3 Chrome（Windows 侧，专用 profile）

```bash
bash scripts/launch-chrome.sh          # 幂等：已在运行则直接返回
curl -s http://127.0.0.1:9223/json/version   # 期望返回 {"Browser":"Chrome/15x...",...}
```

要求：
- 用**专用 profile**（默认 `C:\cdt-profile`），不要用日常浏览的 profile
- Chrome 必须在**登录的 Windows 会话**里运行——服务器机器若无人登录，需配置自动登录
- 为什么不能用 headless：CDT 有瑞数风控（JS 质询 + 指纹检测），会被拦

### 2.4 Python + pdfminer（cninfo 公告 PDF）

```bash
python3 -V                                  # 3.8+
pip3 install --user -i https://mirrors.aliyun.com/pypi/simple/ pdfminer.six
python3 -c "import pdfminer; print('pdfminer', pdfminer.__version__)"
```

> 用阿里云镜像：官方源在国内常超时。
> `--user` 装到 `~/.local`，cron 的 `HOME` 正确时能 import；**换用户跑 cron 会失效**。

### 2.5 LLM 连通性

```bash
cd ~/agents/pi_csp_agent      # 先完成 §3 的 .env
node -e '
require("./scripts/lib/wecom.js").loadEnv();
const cfg=require("./scenarios/preclinical/config.json");
fetch(cfg.llm.baseUrl+"/chat/completions",{method:"POST",
  headers:{"content-type":"application/json",authorization:"Bearer "+process.env.DASHSCOPE_API_KEY},
  body:JSON.stringify({model:cfg.llm.model,messages:[{role:"user",content:"只回一个词：ok"}],max_tokens:50,enable_thinking:false})})
 .then(r=>r.json()).then(d=>console.log(d.choices?.[0]?.message?.content || JSON.stringify(d.error)));
'
```

期望输出 `ok`。若报 `invalid_api_key`：Key 与 baseUrl 不匹配（专用 MaaS 端点 vs 百炼公网端点）。

---

## 3. 仓库与密钥

### 3.1 拉代码

```bash
git clone git@github.com:jordan2330/pi_csp_agent.git ~/agents/pi_csp_agent
cd ~/agents/pi_csp_agent
git log --oneline -1          # 记录部署的提交号，写进运维台账
```

### 3.2 `.env`（gitignore，必须手工创建）

```bash
cp .env.example .env
```

四个键，**一个都不能少**：

```ini
WECOM_CORPID=ww...            # 企微「我的企业」→ 企业 ID
WECOM_SECRET=...              # 自建应用 Secret
WECOM_WEBHOOK_KEY=...         # 群机器人 key（周报推送；可不配，则只落表不推群）
DASHSCOPE_API_KEY=sk-...      # 百炼 API Key
```

**生产机绝对不能有 `WECOM_ENV=dev`**：

```bash
grep -q "^WECOM_ENV" .env && echo "❌ 生产机不应设置 WECOM_ENV" || echo "✅ 未设置 = prod"
```

cron 里的脚本**不读** pi 的模型配置，只读 `.env` 的 `DASHSCOPE_API_KEY` + `scenarios/preclinical/config.json` 里的 `llm.*`。

---

## 4. 企微侧准备（管理后台，一次性）

按顺序做，任何一步漏掉都会在 §5 报错：

1. **建自建应用**：管理后台 → 应用管理 → 自建 → 创建；记下 `AgentId`、`Secret`
2. **开通文档 API 权限**：协作 → 文档 → API → 把该应用加入「可调用接口的应用」
3. **配置可信 IP**：应用详情页底部「企业可信 IP」→ 填本机**出口 IPv4**（多个用分号分隔）
   ```bash
   curl -s https://ipinfo.io/ip        # 查出口 IP；换网络后会变，报 60020 时回来改这里
   ```
4. **建群机器人**：目标群 → 群设置 → 群机器人 → 添加 → 复制 Webhook Key
5. **（上线后）加协作者**：表格建好后，把销售加为可编辑成员

自检：

```bash
node scripts/wecom-sync.js checkip     # 报 60020 时会告诉你该加哪个 IP
```

---

## 5. 首次初始化（三张表）

> 顺序不能颠倒：主表 → 临床阶段管线 → 管线交易。
> 每一步都幂等：重复执行不会重复建表。

### 5.1 主表「CSP商机跟踪」

```bash
node scripts/wecom-sync.js init     # 建文档 + 38 字段
node scripts/wecom-sync.js status   # 期望：字段 37~38 / 记录 0
```

建好后：**在企微里把销售加为可编辑协作者**，并把链接发给销售（他们收藏这一个链接即可）。

### 5.2 临床阶段管线（第二张子表：临床阶段管线）

```bash
node scenarios/pipeline/sync.js --init
```

期望输出包含 `✅ 表就绪` 或 `补齐 N 个字段`，并打印 `目标表: env=prod host=<hostname> docid=...`。

> **确认这一行**：`env=prod` 且 host 是生产机主机名。如果显示 `env=dev`，说明 §3.2 的检查漏了。

### 5.3 管线交易（同一文档下的子表）

```bash
node scenarios/preclinical/sync.js --bootstrap --init
```

`--bootstrap` 复用 5.2 建好的「CSP管线商机」文档 docid，在同一文档下 `add_sheet` 并写
`config/wecom-preclinical.<env>.json`；**不加 `--bootstrap` 会因缺 docid 直接报错**（子表必须挂在同一文档下）。

**企微 API 不支持重命名子表**，所以建完后：

> 在企微里双击该子表标签，改名为 **「管线交易信息」**。

### 5.4 验收

```bash
node scripts/wecom-sync.js status                 # 主表
node scenarios/pipeline/sync.js --dry-run         # 应打印"移出 0"（新表为空）
node scenarios/preclinical/sync.js --dry-run
```

---

## 6. 账本迁移（从开发机搬到生产机）

**只有需要保留历史时才做**（新部署可跳过，让采集从今天开始）。

开发机上打包：

```bash
cd ~/agents/pi_csp_agent
tar czf /tmp/csp-ledger.tgz \
  output/history/ledger.json \
  output/history/feedback.json \
  output/history/pipeline-cde.json \
  output/history/pipeline-cbde*.json 2>/dev/null
tar czf /tmp/csp-preclinical.tgz output/history/preclinical config/preclinical-asset-aliases.json config/pipeline-cursor.json 2>/dev/null
```

生产机上还原：

```bash
mkdir -p output/history
tar xzf csp-ledger.tgz -C ~/agents/pi_csp_agent
tar xzf csp-preclinical.tgz -C ~/agents/pi_csp_agent
```

**不要迁**：`config/wecom*.json`（表归属，生产必须自己建）、`.env`（密钥不同）、`config/.wecom_token.json`。

校验：

```bash
node -e 'const s=require("./output/history/pipeline-cde.json");console.log("管线账本",Object.keys(s.rows).length,"行")'
node -e 'const e=require("./output/history/preclinical/events-2026.json");console.log("事件账本",Object.keys(e.events).length,"条")'
```

---

## 7. 定时任务

完整 crontab（含 PATH、Chrome 预热、flock 互斥）**只在 `docs/cron.md` 维护**，照抄即可。要点：

- `PATH` 必须写在 crontab **顶部**（cron 不读 `.profile`，找不到 node）
- 两个用 Chrome 的任务（管线/主表）**共用 `flock -n /tmp/csp-chrome.lock`**，靠时间错开 + 抢锁兜底
- 管线交易不用 Chrome，放周一早上

装完后逐条手测（不要等第二天）：

```bash
crontab -l | tail -6
# 手动跑一遍验证环境（用 cron 的干净环境）
env -i HOME=$HOME PATH=/usr/local/bin:/usr/bin:/bin bash -c \
  "cd $HOME/agents/pi_csp_agent && node scenarios/preclinical/digest.js | head -3"
```

---

## 8. 首次全量运行

```bash
cd ~/agents/pi_csp_agent

# ① 主表（最长，含 FDA + CT.gov + CDT + 富化，通常 20–60 分钟）
bash scripts/launch-chrome.sh
node scripts/run-pipeline.js nitrosamine

# ② 临床阶段管线（首次会翻 CDE 全表，约 20–40 分钟）
node scenarios/pipeline/run.js

# ③ 管线交易（首次约 3–5 分钟）
node scenarios/preclinical/weekly.js
```

---

## 9. 上线验收清单

逐条打勾，**全部通过才算上线完成**：

| # | 检查 | 命令 / 位置 | 期望 |
|---|---|---|---|
| 1 | Node 版本 | `node -v` | v22+ |
| 2 | Chrome CDP | `curl -s http://127.0.0.1:9223/json/version` | 返回 Chrome 版本 |
| 3 | pdfminer | `python3 -c "import pdfminer"` | 无报错 |
| 4 | LLM | §2.5 的探活命令 | 输出 `ok` |
| 5 | 企微 IP 白名单 | `node scripts/wecom-sync.js checkip` | 无 60020 |
| 6 | 三张表就绪 | `node scripts/wecom-sync.js status` + 两个 `--dry-run` | 字段齐全、库与表不冲突 |
| 7 | 生产环境标识 | 任一 `sync` 首行 | `env=prod` |
| 8 | 主表有数据 | 打开表格 | 有当轮商机行 |
| 9 | 管线表有数据 | 打开「临床阶段管线」 | A/B 档行（约 240+） |
| 10 | 交易子表有数据 | 打开「管线交易信息」 | 近 60 天事件 |
| 11 | 群机器人 | `node scenarios/preclinical/digest.js --send` | 群里收到周报 |
| 12 | cron 已装 | `crontab -l` | 5 行（含 PATH） |

---

## 10. 日常运维

| 频率 | 做什么 | 怎么判断正常 |
|---|---|---|
| 每天（自动） | cron 跑完三张表 | `output/cron-*.log` 末尾有 `✅`；表里 `★本次新增` 有变化 |
| 每周 | 看周报 + 看销售反馈 | 周报顶部健康度（抓取 N/过闸 M/事件 K）不该是 0 |
| 每月 | ① 备份账本 ② 刷 FDA 元信息 ③ 看日志体积 | 见下 |
| 每季度 | 复核可信 IP、API Key 有效期、Chrome 版本 | — |

**每月备份**（账本是派生数据，丢了要重采 1–2 小时）：

```bash
mkdir -p ~/backup/csp && tar czf ~/backup/csp/ledger-$(date +%F).tgz \
  output/history/*.json output/history/preclinical config/pipeline-cursor.json
ls -t ~/backup/csp/*.tgz | tail -n +7 | xargs -r rm      # 只留最近 6 份
```

**FDA 元信息刷新**（人工跑，不做 cron；FDA 页面季度更新）：

```bash
node scripts/fda-refresh.js --dry-run     # 先看会改什么
node scripts/fda-refresh.js               # 确认后执行（自带安全阀与备份）
```

**日志**：`output/cron-*.log`，按月看体积，可直接 `truncate -s 0` 清空。

---

## 11. 故障处理与回滚

| 症状 | 原因 | 处理 |
|---|---|---|
| 日志只有 `node: command not found` | crontab 顶部没写 `PATH` | 按 `docs/cron.md` 补 |
| `60020 not allow to access from your ip` | 出口 IP 变了 | `node scripts/wecom-sync.js checkip`，把新 IP 加进可信 IP |
| `guardWrite` 拒绝写入 | 配置里的 env/host 与当前不匹配 | 开发机：`WECOM_ENV=dev`；换机：`WECOM_ADOPT=1 node ... init`（一次性接管） |
| 表内容突然少了很多 | 缩表护栏被绕过 / 口径改错 | 用最近备份恢复账本后重跑 `sync`；口径改动应先 `--dry-run` |
| 抓取全是 0 条 | 源挂了 / Key 失效 | 看 `output/cron-*.log` 第一条错误；LLM 缺 Key 会直接 `exit 1` |
| 周报没发 | 前两步失败 / 未配 webhook / `env != prod` | 手动 `node scenarios/preclinical/digest.js` 看输出 |
| 某场景连续几天没更新 | 被 `flock -n` 跳过（前一个任务卡住） | `ps aux | grep node`，清掉僵尸进程 |

**回滚到上一个版本**：

```bash
cd ~/agents/pi_csp_agent
git log --oneline -10                 # 找到上一个可用提交
git checkout <commit>                 # 回滚代码（账本不动）
node scenarios/pipeline/sync.js --dry-run   # 先看会不会大改表
```

> 表结构变更（加列/改列）不可逆自动回滚——`sync.js --init` 只补缺列，不删列。

---

## 12. 安全与合规

密钥只放 `.env`（gitignore），不得写进代码/日志/群消息；客户数据与联系人渠道不得导出到个人设备。
**数据源与采集合规红线以 `AGENTS.md` 为准**（医药魔方禁爬、HKEXnews 禁用、CDT 真浏览器不伪造指纹、PIPL 只存渠道类型+域名），此处不再重述。

## 13. 版本升级流程

```bash
cd ~/agents/pi_csp_agent
git pull
grep -A3 "未做\|不兼容" CHANGELOG.md | head -20     # 看有没有不兼容变更
node scenarios/pipeline/sync.js --dry-run           # 预演表变更
node scenarios/preclinical/sync.js --dry-run
```

升级后**必做**：
1. 跑一次三场景（§8）
2. 对照 §9 验收清单
3. 如涉及列结构变更，按 CHANGELOG 里的说明执行 `--init`（补列）或 `reorder`

**不要**在升级当天改口径（口径 + 代码同时变，出问题分不清是谁的锅）。

---

## 14. 关键文件清单

| 路径 | 是否入库 | 必须备份 | 说明 |
|---|---|---|---|
| `.env` | ❌ gitignore | ✅ | 四个密钥 |
| `config/wecom*.json` | ❌ gitignore | ✅ | 表归属（docid/sheet_id） |
| `config/.wecom_token.json` | ❌ gitignore | ❌ | token 缓存，可重建 |
| `config/pipeline-cursor.json` | ❌ gitignore | ✅ | 增量游标（丢了会重扫） |
| `config/preclinical-asset-aliases.json` | ✅ | ✅ | 代号别名（自动学，丢了会重复） |
| `output/history/*.json` | ❌ gitignore | ✅ | 三个场景的账本 |
| `output/history/preclinical/` | ❌ gitignore | ✅ | 事件账本 + 运行档案 |
| `output/runs/` `output/cron-*.log` | ❌ gitignore | ❌ | 快照与日志，可再生 |

> 判断标准：**能不能从代码 + 数据源重建**。能重建的不备份（日志、token），不能的必须备份（账本、游标、表归属）。