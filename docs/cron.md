# 生产机定时任务（唯一出处）

三个场景共用一台机器。**只有两处会互相干扰：Chrome（CDP 9223）与企微 token 缓存**，
所以两个用浏览器的任务必须互斥（`flock`），第三个只用 HTTP，不受影响。

## 完整 crontab（与生产机 w2zbdv04-home 当前一致）

```cron
SHELL=/bin/bash
# cron 不读 .profile：node 由 nvm 管，必须显式给 PATH（否则日志只有 node: command not found）
PATH=/home/guoj01/.nvm/versions/node/v24.22.1/bin:/usr/local/bin:/usr/bin:/bin

# 07:00 确保 Windows 侧 Chrome 已起（幂等：已在运行则立即返回）
0  7 * * *   cd /home/guoj01/agents/pi_csp_agent && bash scripts/launch-chrome.sh >> output/cron-chrome.log 2>&1

# 09:10 临床阶段管线（用 Chrome；实测约 45 分钟，其中 CT.gov 期次富化 ~20 分钟静默无输出）
10 9 * * *   cd /home/guoj01/agents/pi_csp_agent && flock -n /tmp/csp-chrome.lock node scenarios/pipeline/run.js >> output/cron-pipeline.log 2>&1

# 周一 09:40 管线交易（纯 HTTP，不抢 Chrome）
40 9 * * 1   cd /home/guoj01/agents/pi_csp_agent && node scenarios/preclinical/weekly.js >> output/cron-deals.log 2>&1

# 周一 12:00 主表 nitrosamine（用 Chrome，与 09:10 共用同一把锁）
0 12 * * 1   cd /home/guoj01/agents/pi_csp_agent && flock -w 7200 /tmp/csp-chrome.lock node scripts/run-pipeline.js nitrosamine >> output/runs/cron.log 2>&1
```

## 为什么这么排

| 设计 | 原因 |
|---|---|
| `PATH` 写死在顶部 | cron 不读 `.profile`，找不到 nvm 装的 node |
| `launch-chrome.sh` 单独一行在 07:00 | 它幂等（已在运行就返回）；比每个任务里都写一遍干净 |
| 两个 Chrome 任务同一把 `flock` | `browser.js` 每次 `newPage()`，并发时标签页不互踩，但共用同一 profile 的 Cookie 与 CDT 节流配置，会互相拖慢/触发风控 |
| 管线用 `flock -n`，主表用 `flock -w 7200` | **日频可以跳过，周频不能**：管线拖长时主表宁可等 2 小时也要跑；反过来若主表先起，管线当天跳过无损失 |
| 主表放最后（12:00） | 它最重（FDA + CT.gov + CDT + 富化），且周频，晚一点不影响 |
| 管线交易放周一 | 公众号 RSS 每号只给最近 20 条，日频抓不到增量、月频会漏 |
| 日志分四个文件 | 出问题一眼知道是哪个场景 |

⚠️ **手动跑不持锁**：`node scenarios/pipeline/run.js` 直接跑会绕过 flock。
手动与 cron 可能撞上时，自己套一层：`flock -w 3600 /tmp/csp-chrome.lock node scenarios/pipeline/run.js`。

## 上线前必须验的四件事

```bash
crontab -l | tail -5                              # 1. 四条都在，PATH 在最上面
cd $HOME/agents/pi_csp_agent
curl -s --max-time 5 http://127.0.0.1:9223/json/version   # 2. Chrome CDP 通
node scenarios/preclinical/sync.js --dry-run      # 3. 企微连通 + 护栏正常
python3 -c "import pdfminer; print('pdfminer ok')" # 4. cninfo PDF 能解析（cron 同环境跑）
```

## 常见故障

| 症状 | 原因 |
|---|---|
| 日志只有 `node: command not found` | 顶部 `PATH` 没写，或写错路径 |
| 某场景连续几天没更新 | 被 `flock -n` 跳过（前一个任务卡住没退出）→ 查 `/tmp/csp-chrome.lock` 和对应日志 |
| 周报没发 | `weekly.js` 前两步失败就停（没数据不发）；或 `WECOM_WEBHOOK_KEY` 未配；或 `WECOM_ENV != prod`（dev 只打印不推送） |
| 抓取全是 0 条 | wechat2RSS 挂了 / `DASHSCOPE_API_KEY` 缺失（`run.js` 会直接 exit 1） |
| 表里突然少了很多行 | 缩表护栏会拦住（保留行 < 表内一半 → 拒绝写入）。确属口径调整再 `WECOM_ALLOW_SHRINK=1` |

## 环境区分

- 生产机：`.env` 里 **不要** 写 `WECOM_ENV=dev`（不设 = prod）
- 开发机：`.env` 必须有 `WECOM_ENV=dev`，且**不装 crontab**（会与手动跑抢 Chrome）