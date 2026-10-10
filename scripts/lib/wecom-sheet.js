/**
 * 智能表格同步器 —— 唯一交付物（v5.0.0 起取代 Excel）
 *
 * 表内容口径（v5.0.0-rc.2，单 sheet 工作清单）：
 *   **表 = 窗口内活跃商机 ∪ 有反馈的线索**（销售跟过的不消失）
 *   已过窗口 / 已归档行**不进表**（归档行仅有账本元信息、无联系方式，对销售无价值；
 *   本地账本 ledger.json / 快照仍保留全量记录）——出窗口且无反馈的行会被删除
 *
 * 数据流（每次 pipeline 运行一次 sync）：
 *   1. buildLeadModel + flattenTrials → 一行 = 一条商机（含首见/窗口/★ 标记）
 *   2. get_records 全表拉取 → {商机键: record} 映射
 *   3. 反馈拉取：销售的「跟进状态/负责人/跟进备注/跟进日期」变化 → 沉淀进 feedback.json 事件流
 *   4. upsert：新键 add_records；已有键**只写变化的字段**；表里的反馈列永不写
 *      —— update_records 已验证为字段级合并（PoC verify-update），与销售互不覆盖
 *   5. 返回统计 + 表格链接（对齐原 generateWorkbook 契约，pipeline 日志无需大改）
 *
 * 交互约定（销售侧）：
 *   - 数据列由 pipeline 独占写；反馈 4 列由销售独占写；系统 4 列表格自动维护（操作留痕）
 *   - 行永不删除：已过窗口/已归档行保留在表内（业务视图过滤即可）
 *
 * 账本：output/history/feedback.json（事件流 { current, history }，gitignore）
 *   current = 各商机的当前反馈值（diff 基准）；history = 每次变化的留档（谁/何时/改了什么）
 */

const fs = require('fs');
const path = require('path');
const W = require('./wecom.js');
const { buildLeadModel, flattenTrials } = require('./report.js');
const hist = require('./history.js');

const WS = path.resolve(__dirname, '..', '..');
const FB_FILE = path.join(WS, 'output', 'history', 'feedback.json');
const DEFAULT_DOC_NAME = 'CSP商机跟踪';

// ── 选项（文本与颜色；写入/比较都以 text 为准，id 运行时从字段定义取）──
const CAT_TEXT = { 1: 'Cat1-极高风险', 2: 'Cat2-高风险', 3: 'Cat3-中高风险', 4: 'Cat4-中风险', 5: 'Cat5-低风险' };
const sel = (text, style) => ({ text, style });
// 字段顺序 = 销售视角（从左到右阅读顺序）：① 判断价值 ② 客户与联系 ③ 方案与依据 ④ 反馈（销售填） ⑤ 溯源 ⑥ 系统列（最右，最后）
// 注意：add_fields 为前插，重排需按期望顺序倒序添加（见 wecom-sync.js reorder）
const SCHEMA = [
  { field_title: '商机键', field_type: 'FIELD_TYPE_TEXT' },   // 主字段（不可删，内容=source|regNo）
  // ① 判断价值（前 7 列，销售第一眼）
  { field_title: '分组', field_type: 'FIELD_TYPE_SINGLE_SELECT', property_single_select: { options: [sel('P1-口服固体', 12), sel('P2-其他剂型', 9)] } },
  { field_title: '风险等级', field_type: 'FIELD_TYPE_SINGLE_SELECT', property_single_select: { options: Object.values(CAT_TEXT).map((t, i) => sel(t, [18, 20, 21, 16, 9][i])) } },
  { field_title: '★本次新增', field_type: 'FIELD_TYPE_CHECKBOX' },
  { field_title: '主要API(中文)', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '主要API(英文)', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '涉及API(含Cat)', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: 'AI Limit', field_type: 'FIELD_TYPE_TEXT' },
  // ② 客户与联系方式（销售要打电话）
  { field_title: '申请人/企业', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '产品名称', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '剂型', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '联系人', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '电话', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '邮箱', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '地址', field_type: 'FIELD_TYPE_TEXT' },
  // ③ 推荐方案与判断依据
  { field_title: '推荐CSP方案', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '待确认', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '药物分类', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '注册分类', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '分类依据', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '试验状态', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '分期', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '适应症/试验题目', field_type: 'FIELD_TYPE_TEXT' },
  // ④ 反馈列（销售独占写；放在销售操作区）
  { field_title: '跟进状态', field_type: 'FIELD_TYPE_SINGLE_SELECT', property_single_select: { options: [sel('待跟进', 9), sel('跟进中', 12), sel('已联系', 16), sel('不感兴趣', 18), sel('已转化', 19)] } },
  { field_title: '负责人', field_type: 'FIELD_TYPE_USER', property_user: { is_multiple: false, is_notified: true } },
  { field_title: '跟进备注', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '跟进日期', field_type: 'FIELD_TYPE_DATE_TIME', property_date_time: { format: 'yyyy-mm-dd' } },
  // ⑤ 溯源
  { field_title: '登记号/NCT', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '详情链接', field_type: 'FIELD_TYPE_URL', property_url: { type: 'LINK_TYPE_ICON_TEXT' } },
  { field_title: '登记日期', field_type: 'FIELD_TYPE_DATE_TIME', property_date_time: { format: 'yyyy-mm-dd' } },
  { field_title: '首次发现', field_type: 'FIELD_TYPE_DATE_TIME', property_date_time: { format: 'yyyy-mm-dd' } },
  { field_title: '窗口状态', field_type: 'FIELD_TYPE_SINGLE_SELECT', property_single_select: { options: [sel('窗口内', 16), sel('已过窗口', 21), sel('已归档', 9)] } },
  { field_title: '来源', field_type: 'FIELD_TYPE_SINGLE_SELECT', property_single_select: { options: [sel('CT.gov', 3), sel('CDT', 5)] } },
  // ⑥ 系统列（表格自动维护，最右）
  { field_title: '创建人', field_type: 'FIELD_TYPE_CREATED_USER' },
  { field_title: '创建时间', field_type: 'FIELD_TYPE_CREATED_TIME', property_created_time: { format: 'yyyy-mm-dd hh:mm' } },
  { field_title: '最后编辑人', field_type: 'FIELD_TYPE_MODIFIED_USER' },
  { field_title: '最后编辑时间', field_type: 'FIELD_TYPE_MODIFIED_TIME', property_modified_time: { format: 'yyyy-mm-dd hh:mm' } }
];
const FEEDBACK_TITLES = new Set(['跟进状态', '负责人', '跟进备注', '跟进日期']);
const SYSTEM_TYPES = new Set(['FIELD_TYPE_CREATED_USER', 'FIELD_TYPE_CREATED_TIME', 'FIELD_TYPE_MODIFIED_USER', 'FIELD_TYPE_MODIFIED_TIME']);
const DATA_FIELDS = SCHEMA.filter(f => !FEEDBACK_TITLES.has(f.field_title) && !SYSTEM_TYPES.has(f.field_type));

const log = (...a) => console.log(...a);

// ── 反馈账本（事件流）──
function loadFeedback() { try { return JSON.parse(fs.readFileSync(FB_FILE, 'utf8')); } catch { return { current: {}, history: [] }; } }
function saveFeedback(fb) {
  fs.mkdirSync(path.dirname(FB_FILE), { recursive: true });
  const tmp = FB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(fb, null, 1));
  fs.renameSync(tmp, FB_FILE);
}

// ── 字段定义索引（含单选选项 id）──
async function fieldIndex() {
  const c = W.readCfg();
  const { fields = [] } = await W.sheet.getFields(c.docid, c.sheet_id);
  const byTitle = {};
  for (const f of fields) byTitle[f.field_title] = f;
  return byTitle;
}
function optionOf(byTitle, title, text) {
  const opt = (byTitle[title]?.property_single_select?.options || []).find(o => o.text === text);
  return opt ? { id: opt.id, text: opt.text } : null;
}

// ── 一行的期望值（数据列全集；反馈/系统列不在其中）──
function rowValues(row, byTitle) {
  const S = (title, text) => { const o = optionOf(byTitle, title, text); return o ? W.V.select(o) : []; };
  const v = {
    '商机键': W.V.text(row.key),
    '★本次新增': row.star === '★',
    '分组': S('分组', row.osd ? 'P1-口服固体' : 'P2-其他剂型'),
    '风险等级': S('风险等级', CAT_TEXT[row.catNum]),
    '主要API(中文)': W.V.text(row.apiCn),
    '主要API(英文)': W.V.text(row.apiEn),
    '涉及API(含Cat)': W.V.text(row.relatedApis),
    'AI Limit': W.V.text(row.aiLimit),
    '申请人/企业': W.V.text(row.sponsor),
    '产品名称': W.V.text(row.drugName),
    '剂型': W.V.text(row.dosageForm),
    '药物分类': W.V.text(row.drugClass),
    '分类依据': W.V.text(row.classBasis),
    '注册分类': W.V.text(row.regClass),
    '推荐CSP方案': W.V.text(row.csp),
    '待确认': W.V.text(row.confirm),
    '试验状态': W.V.text(row.status),
    '适应症/试验题目': W.V.text(row.indication),
    '分期': W.V.text(row.phase),
    '登记号/NCT': W.V.text(row.regNo),
    '登记日期': W.V.date(row.regDate),
    '首次发现': W.V.date(row.firstSeen),
    '窗口状态': S('窗口状态', row.windowState),
    '联系人': W.V.text(row.contactName),
    '电话': W.V.text(row.contactPhone),
    '邮箱': W.V.text(row.contactEmail),
    '地址': W.V.text(row.contactAddress),
    '来源': S('来源', row.source)
  };
  const link = detailLink(row);
  v['详情链接'] = link ? W.V.url(row.regNo, link) : [];
  return v;
}
function detailLink(row) {
  if (row.source === 'CT.gov' && row.regNo) return `https://clinicaltrials.gov/study/${row.regNo}`;
  return '';   // CDT 详情页为动态页，无稳定直链；留空
}

// ── 值比较（把 API 读写格式归一成标量，避免结构噪声造成重复 update）──
function scalarOf(field, val) {
  if (val == null || val === '') return '';
  switch (field.field_type) {
    case 'FIELD_TYPE_TEXT': return W.plain(val);
    case 'FIELD_TYPE_URL': return Array.isArray(val) ? (val[0]?.link || '') : '';
    case 'FIELD_TYPE_DATE_TIME': return String(new Date(Number(val)).toISOString().slice(0, 10));
    case 'FIELD_TYPE_SINGLE_SELECT': return Array.isArray(val) ? (val[0]?.text || '') : '';
    case 'FIELD_TYPE_CHECKBOX': return val === true ? '1' : '0';
    default: return W.plain(val);
  }
}

// ── 反馈拉取：表里的反馈列变化 → feedback.json 事件流 ──
function pullFeedback(records) {
  const fb = loadFeedback();
  const changes = [];
  for (const rec of records) {
    const key = W.plain(rec.values?.['商机键']);
    if (!key || key.startsWith('__no_regno_')) continue;
    const cur = {
      status: W.plain(rec.values['跟进状态']),
      owner: (rec.values['负责人'] || []).map(u => u.user_id).filter(Boolean).join(','),
      note: W.plain(rec.values['跟进备注']),
      fdate: rec.values['跟进日期'] ? new Date(Number(rec.values['跟进日期'])).toISOString().slice(0, 10) : ''
    };
    if (!cur.status && !cur.owner && !cur.note && !cur.fdate) continue;   // 无反馈，跳过
    const prev = fb.current[key];
    if (prev && prev.status === cur.status && prev.owner === cur.owner && prev.note === cur.note && prev.fdate === cur.fdate) continue;
    const ev = {
      ...cur,
      by: rec.updater_name || '（未知）',
      at: rec.update_time ? new Date(Number(rec.update_time)).toISOString().slice(0, 16).replace('T', ' ') : ''
    };
    fb.current[key] = ev;
    fb.history.push({ key, ...ev });
    changes.push({ key, ...ev });
  }
  saveFeedback(fb);
  return changes;
}

// ══════════════════════════════════════════════════
// 初始化：创建正式表 + 全字段（幂等：已有则复用/补齐）
// ══════════════════════════════════════════════════
async function initSheet(docName = DEFAULT_DOC_NAME) {
  const old = W.readCfg();
  if (old.docid && old.sheet_id && old.official) { log(`正式表已存在: ${old.url}`); return old; }

  log('创建正式智能表格...');
  const doc = await W.sheet.createDoc(docName);
  const docid = doc.docid || doc.doc_id;
  const url = doc.url || `https://doc.weixin.qq.com/smartsheet/${docid}`;
  const sheets = await W.sheet.getSheets(docid);
  const sheetId = (sheets.sheet_list || sheets.sheets || [])[0]?.sheet_id;
  if (!sheetId) throw new Error(`未取到子表ID: ${JSON.stringify(sheets).slice(0, 300)}`);

  // 清理新表默认字段：保留一个文本字段复用为「商机键」，其余删除（失败则提示手动清理）
  const def = (await W.sheet.getFields(docid, sheetId)).fields || [];
  const texts = def.filter(f => f.field_type === 'FIELD_TYPE_TEXT');
  const others = def.filter(f => f.field_type !== 'FIELD_TYPE_TEXT');
  try {
    if (texts.length) {
      // update_fields 必须带 field_type（缺了报 2022010 invalid field type）
      await W.sheet.updateFields(docid, sheetId, [{ field_id: texts[0].field_id, field_title: '商机键', field_type: texts[0].field_type }]);
      if (others.length) await W.sheet.deleteFields(docid, sheetId, others.map(f => f.field_id));
      log(`默认字段已处理：主字段改名为「商机键」，删除 ${others.length} 个默认字段`);
    }
  } catch (e) {
    log(`⚠️ 默认字段自动清理失败（${e.message}）——请在表格 UI 里手动删除「文本/单选/人员/数字/日期」等默认列`);
  }

  const have = new Set(((await W.sheet.getFields(docid, sheetId)).fields || []).map(f => f.field_title));
  const missing = SCHEMA.filter(f => !have.has(f.field_title));
  if (missing.length) {
    await W.sheet.addFields(docid, sheetId, missing);
    log(`已添加 ${missing.length} 个字段`);
  }
  // 新建表自带几条空记录 → 清掉（只删主键为空的，安全）
  try {
    const empties = (await W.sheet.getRecords(docid, sheetId)).filter(r => !W.plain(r.values?.['商机键']));
    if (empties.length) {
      await W.sheet.deleteRecords(docid, sheetId, empties.map(r => r.record_id));
      log(`已清理 ${empties.length} 条默认空记录`);
    }
  } catch (_) { /* 清理失败不影响使用 */ }
  W.writeCfg({ docid, sheet_id: sheetId, url, official: true, created_at: new Date().toISOString() });
  log(`✅ 正式表就绪: ${url}`);
  return { docid, sheet_id: sheetId, url };
}

// ══════════════════════════════════════════════════
// 主入口：与 pipeline 的对接点（对齐原 generateWorkbook 契约）
// ══════════════════════════════════════════════════
async function sync(snapshot, scenario, isFull, meta = {}) {
  const ctx = buildLeadModel(snapshot, scenario, isFull);
  const rows = flattenTrials(ctx, 'all');
  const activeRows = rows.filter(r => r.windowState === '窗口内');
  const newRows = rows.filter(r => r.star === '★').length;
  const newOutWin = rows.filter(r => r._isNewRaw && r.windowState !== '窗口内').length;

  const cfg = W.readCfg();
  if (!cfg.docid) throw new Error('智能表格未初始化 —— 先跑 node scripts/wecom-sync.js init');
  const byTitle = await fieldIndex();

  // ── 拉全表（一次调用翻页取回；含反馈列 + 系统留痕列）──
  const records = await W.sheet.getRecords(cfg.docid, cfg.sheet_id);
  const existing = new Map();
  for (const rec of records) {
    const k = W.plain(rec.values?.['商机键']);
    if (k) existing.set(k, rec);
  }

  // ── 反馈拉取（销售的输入进账本）──
  const fbChanges = pullFeedback(records);
  if (fbChanges.length) log(`销售反馈：${fbChanges.length} 条变化已入账（feedback.json）`);

  // ── 表内容口径：窗口内 ∪ 有反馈（销售跟过的线索不消失）；其余（出窗口/归档）移出表 ──
  const recHasFeedback = (rec) => !!(W.plain(rec.values?.['跟进状态']) || W.plain(rec.values?.['跟进备注']) || (rec.values?.['负责人'] || []).length);
  const feedbackKeys = new Set([...existing.entries()].filter(([, rec]) => recHasFeedback(rec)).map(([k]) => k));
  const keep = rows.filter(r => r.windowState === '窗口内' || feedbackKeys.has(r.key));
  const keepKeys = new Set(keep.map(r => r.key));

  // ── upsert：新键 add；已有键只写变化字段（反馈列永不写）──
  const toAdd = [], toUpdate = [];
  for (const row of keep) {
    const desired = rowValues(row, byTitle);
    const cur = existing.get(row.key);
    if (!cur) { toAdd.push({ values: desired }); continue; }
    const diff = {};
    for (const f of DATA_FIELDS) {
      const title = f.field_title;
      if (scalarOf(f, desired[title]) !== scalarOf(f, cur.values?.[title])) diff[title] = desired[title];
    }
    if (Object.keys(diff).length) toUpdate.push({ record_id: cur.record_id, values: diff });
  }

  // ── 清理：表里有但不在保留集的记录（出窗口且无反馈 / 归档行）→ 删除（本地账本留档）──
  const toDelete = [...existing.entries()].filter(([k]) => !keepKeys.has(k)).map(([, rec]) => rec.record_id);

  const added = toAdd.length ? (await W.sheet.addRecords(cfg.docid, cfg.sheet_id, toAdd)).length : 0;
  const updated = toUpdate.length ? (await W.sheet.updateRecords(cfg.docid, cfg.sheet_id, toUpdate)).length : 0;
  const deleted = toDelete.length ? (await W.sheet.deleteRecords(cfg.docid, cfg.sheet_id, toDelete), toDelete.length) : 0;
  if (deleted) log(`移出表: ${deleted} 行（已过窗口且无反馈 / 归档行；本地账本仍保留）`);

  // ── 批次档案（runs.json，口径与原 Excel 版一致）──
  try {
    const srcCount = {};
    Object.values(ctx.enrichedApis).forEach(a => [...a.trials, ...(a.historyTrials || [])]
      .forEach(t => { srcCount[t.source] = (srcCount[t.source] || 0) + 1; }));
    let cdeStat = { total: 0, signals: 0 };
    try {
      const cdeProducts = Object.values(require('./cde-classify').loadCache().products || {});
      cdeStat = { total: cdeProducts.length, signals: cdeProducts.filter(e => e.confidence === 'high').length };
    } catch (_) {}
    hist.appendRun({
      run: meta.run || `${ctx.today} (重建)`, date: meta.date || ctx.today,
      new: newRows, new_records: meta.new_records != null ? meta.new_records : newRows,
      total: rows.length, total_active: activeRows.length,
      archived: rows.filter(r => r.windowState === '已归档').length,
      sources: srcCount, enrich: { cde_products: cdeStat.total, cde_signals: cdeStat.signals }
    });
  } catch (_) { /* runs.json 不可写时不影响交付物 */ }

  return {
    url: cfg.url,
    rows: keep.length,
    activeRows: keep.filter(r => r.windowState === '窗口内').length,
    outOfScope: rows.length - keep.length,
    p1: keep.filter(r => r.windowState === '窗口内' && r.osd).length,
    p2: keep.filter(r => r.windowState === '窗口内' && !r.osd).length,
    newRows, newOutWin,
    added, updated, deleted, fbChanges: fbChanges.length,
    violations: (rows.violations || []).length
  };
}

module.exports = { initSheet, sync, SCHEMA, FB_FILE, loadFeedback, rowValues, scalarOf };