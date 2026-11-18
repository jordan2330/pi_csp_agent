# 生产机定时任务（唯一出处）

三个场景共用一台机器。**只有两处会互相干扰：Chrome（CDP 9223）与企微 token 缓存**，
所以两个用浏览器的任务必须互斥（`flock`），第三个只用 HTTP，不受影响。

## 完整 crontab

```cron
# cron 的 PATH 里没有 node（本机 node 由 pi 安装在 ~/.local/share/pi-node/current/bin/）
# 这一段是必须的，否则所有任务静默失败（日志里只有 "node: command not found"）
PATH=/home/guoj01/.local/share/pi-node/current/bin:/usr/local/bin:/usr/bin:/bin

# 07:00 确保 Windows 侧 Chrome 已起（幂等：已在运行则立即返回）
0  7 * * *   cd $HOME/agents/pi_csp_agent && bash scripts/launch-chrome.sh >> output/cron-chrome.log 2>&1

# 07:10 临床阶段管线（用 Chrome）→ 子表「临床阶段管线」
10 7 * * *   cd $HOME/agents/pi_csp_agent && flock -n /tmp/csp-chrome.lock node scenarios/pipeline/run.js >> output/cron-pipeline.log 2>&1

# 07:40 主表 nitrosamine（用 Chrome，同一把锁 → 与上面错开 30 分钟）
40 7 * * *   cd $HOME/agents/pi_csp_agent && flock -n /tmp/csp-chrome.lock node scripts/run-pipeline.js nitrosamine >> output/cron-main.log 2>&1

# 周一 08:20 管线交易（纯 HTTP，不抢 Chrome）
20 8 * * 1   cd $HOME/agents/pi_csp_agent && node scenarios/preclinical/weekly.js >> output/cron-deals.log 2>&1
```

## 为什么这么排

| 设计 | 原因 |
|---|---|
| `PATH` 写死在顶部 | cron 不读 `.profile`，找不到 pi 安装的 node |
| `launch-chrome.sh` 单独一行在 07:00 | 它幂等（已在运行就返回）；比每个任务里都写一遍干净 |
| 两个 Chrome 任务同一把 `flock` | 抢不到锁就跳过本轮，避免标签页互相踩；比单纯错开时间更可靠（某次跑超时不会连累下一轮） |
| `flock -n`（非阻塞） | 宁可跳过一轮，也不要排队堆叠 |
| 主表放最后 | 它最重（FDA + CT.gov + CDT + 富化），前面两个轻的先跑完 |
| 管线交易放周一 | 公众号 RSS 每号只给最近 20 条，日频抓不到增量、月频会漏 |
| 日志分四个文件 | 出问题一眼知道是哪个场景 |

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