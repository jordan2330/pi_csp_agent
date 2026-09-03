# v2 采集层验收标准（来自 v1 已知坑）

> 本文档是 v2 采集层重写的**需求契约**，不是散文。
> 每条 = 一个 v1 踩过的坑 → 一条可验收的标准。
> 素材来源：master 上 `PLAN.md`（v1.4 维修单）、git log（v1.2/v1.4）、v1 代码实现。
> 范围：只覆盖采集层（抓取 → 入库写入口）。持久化 schema、前端、leads 生命周期另文定义。
> 原则：场景无关。采集层是通用层，`scenarios/<name>/enrich.js` 是场景钩子，验收标准不许场景特判。

## 1. 配置必须可生效（坑 A1）

- 背景：`loadThrottle()` 从 `skills/.../scripts/` 相对寻址 `../../config/cdt-throttle.json`，解析到不存在的路径，**静默回退内置默认值**，改配置无效。
- 验收：采集层所有配置加载必须：
  - 路径显式解析到已知根（不靠 `__dirname` 相对层数猜）；
  - 配置加载失败/路径缺失 = **报错退出**，禁止静默回退默认值；
  - 有测试证明改 `cdt-throttle.json` 里的值会实际改变请求间隔。

## 2. 增量检测必须幂等（坑 A2）

- 背景：同日第二次运行会拿**昨天**的快照做对比（当天快照被过滤掉），已报过的商机再次标 🆕 重复推送。
- 验收：任意时刻重复运行 pipeline，不得把同一试验第二次标记为新增；「新增」的判定基准 = 最近一次成功完成的运行，而不是"昨天"。

## 3. 写入必须原子（坑 A3）

- 背景：`writeFileSync` 直写缓存，2 小时爬取中进程被杀 → JSON 损坏 → 被迫重跑 Phase 1。
- 验收：所有持久化写入（文件或 DB）必须是原子的：要么完整落盘，要么保持旧状态，进程被杀不得留下半截数据。DB 场景 = 事务，且**提交点后置**（全部业务完成后一次提交，而非边抓边提交）。

## 4. HTTP 抓取必须带退避重试（坑 A4）

- 背景：CT.gov 单次 429/5xx/超时即放弃该 API，本轮不更新，次日自愈但漏 `isNew` 标记。
- 验收：对外 HTTP 请求（CT.gov 及未来任何 REST 源）必须：≥2 次重试、覆盖 429/5xx/超时、递增退避（如 5s→15s→45s）、带超时上限（当前 30s，可配）。

## 5. 浏览器抓取必须断连自愈（v1.2 经验）

- 背景：CDT 走 browserless 远程浏览器，连接断开（`Target closed`/`disconnected`/WebSocket 断）曾导致整轮白跑；v1.2 加了检测 + 恢复。
- 验收：浏览器断连类错误必须自动重连并从**未完成处继续**（CDT = 从当前 regNo 游标续抓，不得从头翻页）；断连后重试有次数上限，超限报错退出（不得无限循环）。

## 6. 增量游标必须持久化且先行（v1 架构约束）

- 背景：CDT 用 `--cursor REGNO` 增量；CT.gov 全量拉取 + NCT ID 集合对比。两者是 v1 增量机制的骨架，v2 改为 DB 后游标/集合的持久化位置变化，但机制不能丢。
- 验收：抓取开始前先读游标（`last_cdt_regno` / NCT 集合），结束后原子写回；中途失败不得推进游标（宁可重抓，不可跳扫）。

## 7. 文本渲染必须转义（坑 A5）

- 背景：试验标题/地址含 `|` 撑破 Markdown 表格。
- 验收：任何进入报告/前端表格的文本字段必须转义分隔符与换行。v2 若前端渲染，同理（HTML 转义/参数化，防注入）。

## 8. 死代码不随重构复活（坑 B）

- 背景：v1.4 删了 `runCDTSearch()`（60 行，无调用方）和 `extractPhaseFromCTGov()`。
- 验收：重写后代码库不得出现无调用方的导出；CLI 调试工具与 pipeline 正式路径分离（`cdt-search.js` 是调试工具，保留可以，但不得成为 pipeline 依赖）。

## 9. 统计数字不得撒谎（坑 C）

- 背景：`totalStudies`/`withContact` 只在"有变化"分支累计，总结数字偏小误导人；`totalCount` 字段名不符实。
- 验收：所有统计在完整遍历后汇总，字段名=语义；报告/前端展示的计数可对照原始数据复核。

## 10. 文档与实现必须同步（坑 D）

- 背景：SKILL.md/README 声称"只搜索未完成组合"，实现是全量拉取对比 —— 文档骗了人。
- 验收：v2 的 SKILL.md/README 由实现反向驱动（先有实现后有描述），CI 不做，但每次提交含文档变更时人工核对。此项对 v2 尤其重要：**SKILL.md 仍是 pipeline 的唯一事实源**（项目铁律），v2 采集层文档必须在 v1 废弃前写全。

## 11. 平台配置必须从一开始就好用（v1.4 经验，非采集层但影响开发）

- 背景：`.pi/settings.json` 路径写错 → skills/scenarios/prompts 从未被加载，v1 撑了大半年才发现。
- 验收：v2.1 工作区 pi 配置从第一天起验证过 `/lead-scan` 可用；此条在 CI 无法测，靠开工首日手动验证。

## 12. 保留的已知取舍（坑 E —— 不许"顺手修掉"）

- **CDT vs CT.gov 两年窗口口径不一致**（CDT regNo 年份 vs 精确日期）：报告/入库层保留 `regDate` 二次过滤兜底。v2 schema 必须保留 `regDate` 字段。
- **场景采集口径由场景决定**：各场景 `scenario.json` 控制 API 列表/翻译表/搜索模式，采集层不内置任何场景知识。

## 13. 采集失败不得静默（新增于 2026-09-03）

- 背景：2026-08-28 browserless 不可达，CDT 全程 0 更新，但快照/报告静默写入（901 条 CDT 全为早跑残留，BD 无感知）。v1.2 断连自愈只管运行中断，不覆盖"根本连不上"。
- 验收：任一时间源整体不可达（连接超时等）时，本次运行输出与 web 审核台**必须标注数据新鲜度**（"CDT 数据截至 <日期>，本轮未更新"）；禁止无标记续期旧数据。

## 附：素材溯源

| 编号 | 来源 | v1 位置 |
|------|------|---------|
| A1 | PLAN.md A1 | `skills/browser_executor/scripts/cdt-search-lib.js` `loadThrottle()` |
| A2 | PLAN.md A2 | `scripts/lib/snapshot.js` `loadPrevResults()` |
| A3 | PLAN.md A3 | `scripts/run-pipeline.js` `saveFDA()` / `snapshot.js` `saveSnapshot()` |
| A4 | PLAN.md A4 | `scripts/lib/sources.js` `ctgovFetch()` |
| A5 | PLAN.md A5 | `scripts/lib/report.js` `renderCell()` |
| B | PLAN.md B | `sources.js` `runCDTSearch` / `enrichment.js` `extractPhaseFromCTGov` |
| C | PLAN.md C | `run-pipeline.js` phase2a / `sources.js` `totalCount` |
| D | PLAN.md D | `prompts/lead-scan.md` / `scenarios/nitrosamine/SKILL.md` / `README.md` |
| E | PLAN.md E | 备注 |
| #5 | v1.2 commit | `cdt-search-lib.js` `isBrowserDeadError()` + 重连 |
| #6 | v1 架构 | `run-pipeline.js` / `sources.js` 增量注释 |
| #11 | v1.4 commit | `.pi/settings.json` |
## 附录 B：Schema 决策（2026-08-31 grilling 锁定）

| 决策 | 内容 |
|------|------|
| trial 唯一键 | `(source, regNo)`（**不含 API**；858 个唯一试验中 411 个命中多 API，同一 NCT 最多挂 5 个 API，复方药 drugName 含多搜索词） |
| trial ↔ API | M2M：`trial_apis(trial_id, api)`；API 是命中关系不是归属；trial→scenario 由"命中该场景的 API 列表"派生 |
| lead 唯一键 | `(scenario, sponsor, 产品)` —— 同一个 sponsor+产品在不同场景是两个 lead（CSP 推荐矩阵/推送/看板均场景化） |
| lead ↔ trial | 1:N（lead 挂 0..N 条试验，UI 展开显示；试验分期/终止重做滚入同一 lead） |
| reported_at | **挂 lead 不挂 trial**（trial 只留 `first_seen_at`，不背业务状态）；"新增" = `leads.reported_at IS NULL` |
| 首轮静默 | 基线 = 对某场景的 leads 执行 `UPDATE ... SET reported_at=now WHERE reported_at IS NULL`；同一条语句复用三个场景：冷启动首轮、新场景首轮、单条重新推送 |
| 新增粒度 | **lead 级**：已有 lead 下新增试验 = 子行 +1，不再算"新商机"（修正 v1 的 trial 级 isNew 恶习） |
| 幂等 | upsert 按 (source, regNo) / (scenario, sponsor, 产品)，重复运行不得重置 reported_at |

## 附录 C：Milestone 0 验收方式（黄金 fixture）

- golden fixture：`docs/fixtures/ctgov-golden-2026-08-28.json`（1398 记录/858 唯一试验，v1.4 完整运行产物；CDT 当天 browserless 失败，残留数据不作基线）
- 验收四条（全部离线、确定性）：① 字段保真往返 ② upsert 幂等 ③ 导出增量/毙掉状态持久（exported_emails、killed_at 不因重灌丢失）④ 游标持久化
- CT.gov 集合对拍：只比"窗口交集内 NCT 集合"，**禁止计数相等对拍**（日期窗口随运行日平移）

## 附录 D：方向修正（2026-09-03 grilling 锁定）

2026-09-03 业务决定：**lead 生命周期全部由 Salesforce 管理**，agent 职责收窄为 采集 → 持久化 → 导出（Excel 供手工导入 SF）。

### 作废/修正
- 附录 B 中 **lead 聚合概念整体作废**（无 lead 表、无 (scenario, sponsor, 产品) 键、无 reported_at 挂 lead）
- 作废：站内看板/认领/超时提醒/停滞标记/企微推送等全部生命周期功能（SF 负责）
- 首轮静默概念**保留但改挂 trial 级**：`trials.first_seen_at` 用于导出增量，无 reported_at

### 新定（2026-09-03）
- **DB 只存 trials**：`trials(source, regNo)` 唯一 + `trial_apis` M2M（不变）+ 全部采集字段含 contactEmail/Phone/Name
- **导出即聚合**：导出层按 email 动态聚合（DB 无预聚合实体）；SF lead 行 = 一个唯一 email 的容器，Description 聚合该 email 下全部试验详情
- **SF 判重只认 email**（Salesforce 侧）：DB 入库去重 = (source, regNo)，**不沿用** SF 的 email 判重逻辑；同一 email 可出现在多条试验下，入库不合并
- **导出增量 = email 级**（SF 判重只认 email 且重复被拒 → 主路径）：`exported_emails(email, exported_at)` 表记录已导出 email；导出列表 = "该 email 从未导出过"的 email 聚合行。**禁止 trial 级增量**（老 email 的新 trial 整行会被 SF 吞掉，BD 无法区分真假成功）
- **姓名拆分**：按最后一个空格拆（英文名），中文名整名进 Last Name、First Name 填 "."（SF 判重只看 email，姓名准确性不影响导入）
- **Company 列** = 该 email 关联试验中 **regDate 最新**的 sponsor
- **无 email 的 trial**：不导出，web 展示"缺 email 清单"供 BD 人工补（CT.gov 约 25% 无 email，CDT 100% 有）
- **采集验收标准新增**：CDT/CT.gov 采集必须含 contactEmail；CDT 实测 100% 有 email（514 唯一），CT.gov 75%（535 唯一），CT.gov 无 email 的试验导出时该行降级（不生成 SF lead 行或标记 pending）

## 附录 E：web 定位修正（2026-09-03）

web = 人工审核台 + 导出器，权限简单（BD 用）：
- **编辑/补全**：BD 可修改 trial 的 email/电话/姓名等字段（补全 25% 无 email 的 CT.gov 试验）；补的值存 DB，成为后续导出的复用资产
- **人工选择是否导出**：导出不是自动的；BD 审核后勾选
- **毙掉/恢复**：BD 可标记无希望 trial（可逆，可恢复）；`killed_at` 挂 trial 级，导出聚合时剔除
- **导出选择 = 反选模型**：默认全部可导出（全量搜索行太多，禁止"勾选要导出的行"）；BD 只需 ①毙掉废 trial（持久） ②取消勾选个别行（本批不导）
- **毙掉粒度确认 = trial 级**（曾议 email 级，否决理由：离职员工 email 不会再挂新试验；即便出现，SF 兜底由 BD 标 No Opportunity，不建第二套状态）

## 附录 F：技术栈与登录（2026-09-03）

- web 审核台 = **Node + Express + better-sqlite3 + 服务端渲染**（原生 HTML/CSS、少量 JS、移动端自适应），Excel 导出用 exceljs（Node 侧生成，与 pipeline 同栈）；不引入前端框架/构建链/第二种语言
- **要登录**：users 表 + 会话，简单权限（BD 用），不做复杂 RBAC
