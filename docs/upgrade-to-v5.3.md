# 升级指引：8243cff → 当前（新增两张管线表）

> 适用：生产机已经在跑 `8243cff`（只有主表「CSP商机跟踪」），现在要加上「管线商机」文档里的两张子表。
> 全部做完约 **20 分钟**（不含首次采集时间）。
> 完整从零部署见 `docs/deploy-production.md`；调度细节见 `docs/cron.md`。

---

## 升级前先备份（2 分钟，不可跳过）

```bash
cd ~/agents/pi_csp_agent
mkdir -p ~/backup/csp && tar czf ~/backup/csp/before-v5.3-$(date +%F).tgz \
  .env config/wecom*.json config/pipeline-cursor.json output/history/ 2>/dev/null
ls -lh ~/backup/csp/ | tail -2
```

---

## Step 1 · 拉代码

```bash
cd ~/agents/pi_csp_agent
git stash -u            # 若有本地改动
git pull
git log --oneline -1    # 记下提交号
```

期望：`git log` 显示当前最新提交（新增 `scenarios/pipeline/`、`scenarios/preclinical/`、`docs/`）。

**不需要 `npm install`**（零依赖）。

---

## Step 2 · 补两个新依赖

这次升级新增了对 **LLM** 和 **PDF 解析** 的依赖，主表不需要它们，所以生产机此前没装。

### 2.1 LLM Key（管线交易场景用）

```bash
grep -q "^DASHSCOPE_API_KEY=" .env && echo "✅ 已有" || echo 'DASHSCOPE_API_KEY=sk-你的key' >> .env
```

### 2.2 pdfminer（cninfo 公告 PDF 提金额）

```bash
pip3 install --user -i https://mirrors.aliyun.com/pypi/simple/ pdfminer.six
python3 -c "import pdfminer; print('pdfminer ok')"
```

### 2.3 确认没有被误设成 dev

```bash
grep -q "^WECOM_ENV" .env && echo "❌ 生产机不能有 WECOM_ENV，删掉这行" || echo "✅ prod 环境"
```

---

## Step 3 · 建「CSP管线商机」文档 + 临床阶段子表

```bash
node scenarios/pipeline/sync.js --init
```

期望输出含：

```
目标表: env=prod host=<生产机主机名> docid=...
✅ 表就绪: https://doc.weixin.qq.com/smartsheet/...
```

> **必须确认 `env=prod`**。显示 `dev` 说明 Step 2.3 没做。
> 这一步会在企微里**新建一个文档**，与主表「CSP商机跟踪」是两个独立文档。

---

## Step 4 · 在同一文档下建「管线交易信息」子表

```bash
node scenarios/preclinical/sync.js --bootstrap --init
```

期望输出：

```
✅ 已在同一文档下建子表 sheet_id=xxxxxx
   企微 API 不能重命名子表 → 请在界面把该标签改成「管线交易信息」
子表就绪：字段 22 列（新增 21）
```

然后**在企微界面手动改名**：打开「CSP管线商机」→ 双击那个显示为乱码/ID 的子表标签 → 改成 **管线交易信息**。

---

## Step 5 · 迁移历史数据（可选，但强烈建议）

不迁的话，管线表要等首次采集跑完才有数据（约 30 分钟）；交易表则要等下周才有一条。

**开发机上**打包：

```bash
cd ~/agents/pi_csp_agent
tar czf /tmp/csp-data.tgz output/history/pipeline-cde.json \
  output/history/pipeline-ledger.json output/history/preclinical \
  config/pipeline-cursor.json config/preclinical-asset-aliases.json 2>/dev/null
scp /tmp/csp-data.tgz <生产机>:/tmp/
```

**生产机上**还原：

```bash
cd ~/agents/pi_csp_agent
tar xzf /tmp/csp-data.tgz
node -e 'const s=require("./output/history/pipeline-cde.json");console.log("管线账本",Object.keys(s.rows).length,"行")'
```

⚠️ **不要迁** `config/wecom*.json`（表归属，生产必须自己建）和 `.env`（密钥不同）。

---

## Step 6 · 加两行 cron

编辑 crontab：`crontab -e`

**如果顶部没有 PATH，先加**（cron 找不到 node 会静默失败）：

```cron
PATH=/home/<你的用户>/.local/share/pi-node/current/bin:/usr/local/bin:/usr/bin:/bin
```

**再加这两行**（主表那条已存在，不用动）：

```cron
# 07:10 临床阶段管线（用 Chrome）
10 7 * * *   cd $HOME/agents/pi_csp_agent && flock -n /tmp/csp-chrome.lock node scenarios/pipeline/run.js >> output/cron-pipeline.log 2>&1

# 周一 08:20 管线交易（不用 Chrome）
20 8 * * 1   cd $HOME/agents/pi_csp_agent && node scenarios/preclinical/weekly.js >> output/cron-deals.log 2>&1
```

**主表那条也建议补上锁**（避免与 07:10 的管线任务抢 Chrome）：

```cron
40 7 * * *   cd $HOME/agents/pi_csp_agent && flock -n /tmp/csp-chrome.lock node scripts/run-pipeline.js nitrosamine >> output/cron-main.log 2>&1
```

> `command -v node` 可以确认你机器上 node 的真实路径，替换上面 PATH 里的那段。

---

## Step 7 · 先手动跑一遍（别等 cron）

```bash
cd ~/agents/pi_csp_agent
bash scripts/launch-chrome.sh                  # 确保 Chrome 在跑
node scenarios/pipeline/run.js                 # 首次会翻 CDE 全表，20–40 分钟
node scenarios/preclinical/sync.js             # 账本 → 子表
node scenarios/preclinical/digest.js           # 打印周报（prod 会推群）
```

---

## Step 8 · 验收（5 条，全绿算完成）

```bash
# ① 两张表都有数据
node scenarios/pipeline/sync.js --dry-run      # 期望：移出 0 / 新增 0（已同步过）
node scenarios/preclinical/sync.js --dry-run

# ② 表归属正确
cat config/wecom-pipeline.json | grep -E 'env|host'
cat config/wecom-preclinical.json | grep -E 'env|host'   # 两者 docid 应相同

# ③ cron 已装
crontab -l | tail -4

# ④ LLM 可用
node scenarios/preclinical/run.js --limit 1 --since-hours 48
# 期望：能看到"抽取完成：有效 N"，而不是 "缺少 DASHSCOPE_API_KEY"

# ⑤ 周报能发
node scenarios/preclinical/digest.js --send
# 期望：企微群收到一条周报
```

**目视确认**：
- 企微里能看到文档「CSP管线商机」，下面两个子表：`智能表1`（临床阶段）和 `管线交易信息`
- 建议把文档名改清楚，并**把销售加为可编辑协作者**

---

## 出问题怎么回退

| 症状 | 处理 |
|---|---|
| `sync` 打印 `env=dev` | `.env` 里有 `WECOM_ENV=dev`，删掉重跑 |
| `60020 not allow to access from your ip` | `node scripts/wecom-sync.js checkip` → 把新 IP 加到企微可信 IP |
| `拒绝写入：目标表由主机 X 创建` | 换机了：`WECOM_ADOPT=1 node scenarios/pipeline/sync.js --init`（一次性接管） |
| 代码要回退 | `git checkout 8243cff`，表里多的两张表在企微里删掉即可（不影响主表） |

**回退是安全的**：这次升级只新增文档/子表 + 新增两个脚本，**主表「CSP商机跟踪」的代码路径一列没改**。