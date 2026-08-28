# 项目检查与优化计划

## Context

对 pi_csp_agent 全仓（pipeline 脚本、lib 通用层、场景 hooks、浏览器脚本、文档）做一次检查与优化。
目标：修复会影响数据正确性/稳定性的 bug，删除死代码，修正与实际实现不符的文档，不做架构改动。

## 已确认的问题清单

### A. 真实 Bug（必须修）

1. **cdt-throttle.json 永不生效**（`skills/browser_executor/scripts/cdt-search-lib.js`）
   `loadThrottle()` 用 `path.join(__dirname, '..', '..', 'config', 'cdt-throttle.json')`，
   解析到 `/workspace/skills/config/`（不存在）→ 静默回退内置默认值。
   目前默认值恰好与配置文件内容一致所以无可见差异，但**改配置无效**。应改为 `'..', '..', '..', 'config', ...`（指向仓库根）。

2. **同日二次运行新增误报**（`scripts/lib/snapshot.js` `loadPrevResults`）
   `f !== todayStr + '.json'` 过滤掉当天快照 → 同日第二次运行会与昨天快照对比，
   第一次运行发现的商机再次标记 🆕 并重复汇报。修复：当天快照存在时优先用它作为 prev。

3. **核心缓存非原子写入**（`scripts/run-pipeline.js` `saveFDA`）
   直接 `writeFileSync(FDA_FILE)`；2 小时爬取中进程被杀 → `fda_nitrosamines.json` 损坏 →
   被迫重跑 Phase 1。修复：写 `FDA_FILE + '.tmp'` 后 `renameSync`（snapshot 写入同理，一并处理）。

4. **CT.gov 请求无重试**（`scripts/lib/sources.js` `ctgovFetch`）
   单次 429/502/超时即失败，该 API 本轮不更新（次日自愈但漏 isNew）。修复：`httpGetJSON` 加 1 次重试 + 递增退避。

5. **Markdown 表格不转义 `|`**（`scripts/lib/report.js` `renderCell`）
   试验标题/地址含 `|` 会撑破表格。修复：单元格内容转义 `|` 和换行。

### B. 死代码（删除）

6. `scripts/lib/sources.js` 的 `runCDTSearch()`（约 60 行 + exports 条目）—— 唯一调用方是旧 batch/offset CLI 路径，pipeline 只用 `cdtSearchOneAPI`。`cdt-search.js` CLI 保留（README 用作调试工具）。
7. `scripts/lib/enrichment.js` 的 `extractPhaseFromCTGov()` —— 无任何调用。

### C. 日志/统计失真（低成本修复）

8. `run-pipeline.js` `phase2a_ctgov`：`totalStudies`/`withContact` 等累计只在"有变化"分支执行，总结数字偏小且误导 → 移到 unchanged-continue 之前。同时删除未使用变量 `updatedOrSame`。
9. `sources.js` `ctgovFetch` 返回字段 `totalCount` 实为拉取数，改名 `fetchedCount`（同步改引用处日志）。

### D. 文档修正（与实现对齐）

10. `prompts/lead-scan.md` 与 `scenarios/nitrosamine/SKILL.md`：增量模式描述写的是"仅搜索未完成的 API × 数据源组合"，实际实现是**每次都搜全部 API**（CT.gov 全拉对比、CDT 游标续搜）。修正描述。
11. `README.md`：删除已不存在的 `searched_cdt`/`searched_ctgov` 字段描述，双源状态说明改为 `last_cdt_regno` 游标机制。
12. `skills/browser_executor/SKILL.md`：`cdt-search.js` 的 `--offset` 分批说明可简化（offset 之 slice 于搜索后，无加速意义），标注其为调试工具。

### E. 备注（不改）

- CDT 与 CT.gov 的 2 年窗口口径不一致（regNo 年份 vs 精确日期）：报告层有 regDate 二次过滤兜底，属已知取舍。
- `.env` 内 API key 已被 gitignore 保护；但该 key 出现在本次会话与日志中，建议在百炼控制台轮换一次（本计划不含此操作）。

## Files to modify

| 文件 | 改动 |
|------|------|
| `skills/browser_executor/scripts/cdt-search-lib.js` | 修复 throttle 配置路径（A1） |
| `scripts/lib/snapshot.js` | 同日快照优先（A2）+ 快照原子写（A3） |
| `scripts/run-pipeline.js` | saveFDA 原子写（A3）、统计累计修正、删未用变量（C8） |
| `scripts/lib/sources.js` | CT.gov 重试（A4）、totalCount 改名（C9）、删 runCDTSearch（B6） |
| `scripts/lib/report.js` | 单元格转义（A5） |
| `scripts/lib/enrichment.js` | 删 extractPhaseFromCTGov（B7） |
| `scenarios/nitrosamine/SKILL.md` | 增量机制描述对齐（D10） |
| `prompts/lead-scan.md` | 同上（D10） |
| `README.md` | 双源状态字段说明（D11） |
| `skills/browser_executor/SKILL.md` | cdt-search.js 说明简化（D12） |

## Reuse

- 原子写：现有 `fs` 工具即可，两行实现，不新增模块。
- CT.gov 重试：`sources.js:httpGetJSON` 内部循环即可；cdt-search-lib 已有同类退避写法可参考（`connectBrowser`）。
- 快照加载逻辑：只改 `loadPrevResults` 的文件过滤条件，`buildResults` 不变。

## Steps

- [x] 1. `cdt-search-lib.js`：修正 loadThrottle 路径为 `../../..`
- [x] 2. `snapshot.js`：同日快照优先作为 prev；快照写入走 tmp+rename
- [x] 3. `run-pipeline.js`：saveFDA 原子写；phase2a 统计累计移到不变分支外；删 `updatedOrSame`
- [x] 4. `sources.js`：httpGetJSON 加 1 次重试（仅超时/5xx，429 退避）；ctgovFetch 字段改名；删 `runCDTSearch` 及导出
- [x] 5. `report.js`：renderCell 转义 `|`/换行
- [x] 6. `enrichment.js`：删 `extractPhaseFromCTGov` 及导出
- [x] 7. 更新 4 个 md 文档（D10-D12）
- [x] 8. 全量 `node --check` + 回归验证

## Verification

- 所有 JS `node --check` 通过。
- 单元级模拟（node -e，无需网络/缓存）：
  - `loadThrottle` 解析路径指向仓库根 config；
  - 同日快照存在时 `loadPrevResults` 返回当天文件；
  - 原子写后无 `.tmp` 残留、内容正确；
  - renderCell 对含 `|` 标题输出的行仍为合法表格行。
- 本机无 `config/fda_nitrosamines.json` 与运行快照（缓存被 gitignore），无法端到端跑 pipeline；
  容器内验证方式：`docker compose run --rm csp-agent node scripts/run-pipeline.js nitrosamine`（增量，秒级至分钟级），
  检查 `output/CSP_Leads_Report.md` 表格渲染正常、`errors.log` 无新增错误。