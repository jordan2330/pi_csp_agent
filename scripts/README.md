# scripts/ 目录是什么

**不是"通用的"，也不是"全是 nitrosamine 的"**——它是 nitrosamine 时代的产出，现在混了三类东西：

| 类别 | 文件 | 谁能改 |
|---|---|---|
| **共享基础设施**（多场景在用，改了要三场景回归） | `lib/wecom.js`（企微 API / env 护栏 / .env 解析）、`lib/cde-classify.js`（CDE 浏览器采集，pipeline 也在用）、`launch-chrome.sh` | 谨慎 |
| **nitrosamine 专属**（主表「CSP商机跟踪」） | `run-pipeline.js`、`wecom-sync.js`、`fda-refresh.js`、`lib/{wecom-sheet,report,sources,snapshot,history,enrichment}.js` | 只影响主表 |
| **已停用但保留备查** | `lib/nmpa-search.js`（AGENTS.md 明确保留；`cde-classify.js` 仍取其工具函数） | 别删 |

**新场景不要往这里加东西**——写到 `scenarios/<name>/` 下（见 `scenarios/pipeline/`、`scenarios/preclinical/`）。

**为什么不把这些搬进 `scenarios/nitrosamine/`**（评估过，不做）：
- `lib/wecom.js` 被三个场景 require，搬过去会变成 `pipeline → scenarios/nitrosamine` 的反向依赖，比现在更糟
- 4 个模块用 `path.resolve(__dirname, '..', '..')` 推仓库根，移动后深度 +1 → 路径静默错位
- 生产机 cron 指向 `scripts/run-pipeline.js`，搬家要同步改 crontab（忘改 = 静默停跑）
- 代价 ≈ 8 文件 + 28 处文档/cron 引用 + 2-3 小时回归，功能收益 0
