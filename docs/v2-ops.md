# v2 运维手册

> 对象：跑 v2 采集/周报/审核台的人。v1（master）不动，本手册只管 v2.1 分支。

## 0. 先分清你刚跑的是 v1 还是 v2

仓库里**两套 pipeline 并存**（v2.1 分支是 v2 开发地，v1 老脚本没删）：

| 特征 | v1 `scripts/run-pipeline.js` | v2 `scripts/v2/collect.js` |
|---|---|---|
| 日志结尾 | `统计: N leads, N new` | `库内 trials: N \| CT.gov as_of: ... \| CDT as_of ...` |
| 数据去哪 | `config/fda_nitrosamines.json` | `config/csp.db`（SQLite） |
| 报告 | 输出 `output/CSP_Leads_Report.md`（执行摘要+全量表） | `scripts/v2/report.js` 另跑，风格不同 |

一句话验证 v2 到底有没有数据：

```bash
docker compose run --rm csp-agent node -e "
const {openDB}=require('./scripts/v2/db');
const db=openDB('config/csp.db');
console.log('trials:', db.prepare('SELECT COUNT(*) c FROM trials').get().c);
console.log('as_of:', db.prepare(\"SELECT * FROM meta WHERE key LIKE '%as_of'\").all());
"
```

`trials: 0` = v2 一次都没真采集过（你跑的总结表是 v1 的）。

---

## 1. 四种运行模式

### a) 例行增量（cron 周中跑，默认）

```bash
docker compose run --rm csp-agent node scripts/v2/collect.js
```

- 每次全量拉 CT.gov（~5-8 min，API 快），CDT 走游标**只翻新页**（快）
- 游标在 `meta.cdt_cursor:<api>`，每个 API 独立，失败不推进
- 40 分钟以内是正常量级（第一次除外）

### b) 全量重跑（什么时候用）

**只在**：① 怀疑数据坏了（改了 parse 逻辑 / 上游数据结构变了）② 首次建库 ③ 换场景。

```bash
# 方式一：CDT 游标清空重抓（CT.gov 每次本来就是全量，无需重置）
docker compose run --rm csp-agent node scripts/v2/reset.js cdt
docker compose run --rm csp-agent node scripts/v2/collect.js

# 方式二：连 CT.gov 数据一起重来
docker compose run --rm csp-agent node scripts/v2/reset.js ctgov
docker compose run --rm csp-agent node scripts/v2/collect.js
```

**注意**：`reset.js everything` = 清库（保留 FDA 清单和账号），等于从零开始。慎用——杀掉 `exported_emails` 会导致 SF 重复导入判重、杀掉 `first_seen_at` 会导致周报全部变"新增"。

### c) 单源跑（补数据/调试）

```bash
# 只跑 CT.gov（约 8 分钟）
docker compose run --rm csp-agent node scripts/v2/collect.js --source ctgov

# 只跑 CDT（browserless 修好后补 CDT 层）
docker compose run --rm csp-agent node scripts/v2/collect.js --source cdt

# 只刷新 FDA 清单
docker compose run --rm csp-agent node scripts/v2/collect.js --source fda
```

- 单源跑**不重置**另一个源的游标、不覆盖 as_of
- 这回答"调试模式还是单次跑"：**改完代码、想快速验证某个源 = --source**；**东西被上游改了、要全量 = reset + 全量**。

### d) 单 API 微调试（-最细粒度，几十秒）

```bash
# 只有 Acarbose 一个搜索词、全部源
docker compose run --rm csp-agent node -e "
const {openDB}=require('./scripts/v2/db');
const {collectAPI}=require('./scripts/v2/sources/ctgov');
(async()=>{
  const db=openDB('config/csp.db');
  const rows=await collectAPI('Acarbose',{cutoff:'2024-09-01'});
  console.log(rows.length, rows[0]?.regNo, rows[0]?.contactEmail);
  // 不写库，纯粹看抓取/解析结果
})().catch(e=>{console.error(e);process.exit(1)});
"
```

## 2. 什么时候用调试模式（pi）

- **调 parse 逻辑**（比如改 cdt.js 的字段映射、改 ctgov.js 的过滤条件）：先把改的地方写好，用 `---apis` 或 单 API 脚本验证"抓出来长什么样"，**再**跑全量。
- **排查某 API 抓不到**：单 API 脚本看原始输出。
- 改完**任何采集代码**，先跑容器内自检：

```bash
docker compose run --rm csp-agent npm run verify
```

全绿再跑真采集。回归自检 15 项离线确定性，不碰真网络。

## 3. 周报（周一早上）

```bash
docker compose run --rm csp-agent node scripts/v2/report.js
```

- 首期 = 全量市场地图（几百行，正常）；之后 = 只报自上次周报后的新增
- 报告头会写 CT.gov / CDT 数据截至哪天；如果 CDT 这轮失败，会红字标注，**老板看到旧数据不怪你**
- MD 文件生成在 `output/CSP_Leads_Report.md`，发送由你的外部脚本做
- 想重发全量（比如换季大清洗）：`node scripts/v2/reset.js report`

## 4. 审核台（日常 BD 操作）

```bash
docker compose up -d web     # http://host:3210，重启后自动拉起
docker compose logs -f web   # 看日志
```

- 缺邮箱的试验在"缺邮箱清单"补，补完全自动进导出候选
- 毙掉/恢复是 trial 级操作，作用于导出和周报的 ⚰️ 标记

## 5. cron 建议（生产机切换后，v2 两行）

```
# 周中采集（避开 v1 的 CDT 窗口！browserless 是共享的）
0 2 * * 3  cd /opt/pi_csp_agent_v2 && docker compose run --rm csp-agent node scripts/v2/collect.js >> output/runs/v2-collect.log 2>&1
# 周一 7:30 周报（供你外部发信脚本取用）
30 7 * * 1 cd /opt/pi_csp_agent_v2 && docker compose run --rm csp-agent node scripts/v2/report.js >> output/runs/v2-report.log 2>&1
```

> **v1 与 v2 千万别同时跑 CDT**——共用一个 browserless 会互相 429。调教期 v2 先一周一次，错开 v1 的跑批日。

## 6. 故障排查速查

| 现象 | 看哪 | 处理 |
|---|---|---|
| CDT 失败 / as_of 不推进 | `meta.cdt_last_error` | browserless 可用性；修好后 `collect.js --source cdt` 补一轮 |
| CT.gov 某 API 连续报错 | 采集日志 `✗ API名` | 单 API 脚本查原始响应 |
| 周报没新增但应该有的 | `meta.report_as_of` vs trials.first_seen_at | 基线>数据时间 = 采集没跑成功 |
| SF 导入重复 | `exported_emails` 是否被重置 | 别用 `reset.js everything` |
| web 打不开 | `docker compose ps` | 端口 3210 是否被占；看 `docker compose logs web` |