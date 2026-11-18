#!/usr/bin/env node
/**
 * 临床前信号交付层 —— 「CSP管线商机」文档下的第二张子表「临床前信号」
 *
 * 与临床阶段表（20 列、公司×资产、7 维评分）**完全独立**：事件行没有期次/注册号/剂型，
 * 行键是 EVT|公司|资产|类型|日期。数据列由 pipeline 独占写，后 4 列归销售手填。
 *
 * 目标：config/wecom-preclinical.json（prod）/ config/wecom-preclinical.dev.json（dev）
 */

const path = require('path');
const W = require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'wecom.js'));

const WS = path.resolve(__dirname, '..', '..');
const log = (...a) => console.log(...a);

const sel = (text, style) => ({ text, style });
// 单选/多选写入必须用**字段真实选项 id**（add_fields 建的选项 id 由服务端生成，不是文本）
let OPT = new Map();
function loadOpts(fields) {
  OPT = new Map((fields || []).filter(f => f.property_single_select).map(f => [f.field_title, f.property_single_select.options || []]));
}
const S = (title, text) => {
  if (!OPT.size) throw new Error('单选选项未加载：先调 loadOpts(getFields(...))（否则会静默写空）');
  const opt = (OPT.get(title) || []).find(o => o.text === text);
  return opt ? [{ id: opt.id, text: opt.text }] : [];     // 选项里没有该值 → 留空（如阶段未知）
};

const SCHEMA = [
  { field_title: '事件键', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '事件日期', field_type: 'FIELD_TYPE_DATE_TIME', property_date_time: { format: 'yyyy-mm-dd' } },
  { field_title: '类型', field_type: 'FIELD_TYPE_SINGLE_SELECT', property_single_select: { options: [sel('授权出海', 12), sel('引进', 9), sel('融资', 11), sel('里程碑', 16), sel('合作', 20)] } },
  { field_title: '中国公司', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '对方', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '资产/代号', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '阶段', field_type: 'FIELD_TYPE_SINGLE_SELECT', property_single_select: { options: [sel('临床前', 12), sel('IND', 9), sel('I期', 16), sel('II期', 16), sel('III期', 11), sel('NDA/上市', 20)] } },
  { field_title: '金额', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '摘要', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '来源', field_type: 'FIELD_TYPE_URL', property_url: { type: 'LINK_TYPE_ICON_TEXT' } },
  // ↓ 销售独占写
  { field_title: '是否已有客户', field_type: 'FIELD_TYPE_SINGLE_SELECT', property_single_select: { options: [sel('是', 11), sel('否', 16), sel('待确认', 20)] } },
  { field_title: '跟进状态', field_type: 'FIELD_TYPE_SINGLE_SELECT', property_single_select: { options: [sel('未跟进', 20), sel('已联系', 12), sel('跟进中', 9), sel('已成交', 11), sel('放弃', 16)] } },
  { field_title: '负责人', field_type: 'FIELD_TYPE_USER' },
  { field_title: '备注', field_type: 'FIELD_TYPE_TEXT' }
];

const FB = ['是否已有客户', '跟进状态', '负责人', '备注'];
const DATA = SCHEMA.map(f => f.field_title).filter(t => !FB.includes(t));
const TYPE_MAP = { license_out: '授权出海', license_in: '引进', financing: '融资', milestone: '里程碑', partnership: '合作', other: '合作' };
// 顺序敏感："III期".includes("I期") 为真 → 必须先匹配 III，再 II，最后 I；IND 要在 NDA 之前（"获批临床"含"获批"）
const PHASE_MAP = [
  [/临床前|PCC/i, '临床前'],
  [/IND|获批临床/i, 'IND'],
  [/III\s*期|Ⅲ|三期/, 'III期'],
  [/II\s*期|Ⅱ|二期/, 'II期'],
  [/I\s*期|Ⅰ|一期/, 'I期'],
  [/NDA|BLA|上市申请|获批上市/i, 'NDA/上市']
];

// 配置与护栏复用 wecom.js（WECOM_TABLE=preclinical 时 cfgFile() 恰好解析到 config/wecom-preclinical[.env].json）
const cfgFile = () => W.cfgFile();
const readCfg = () => W.readCfg();

function targetText(ev) {
  const a = ev.amount_upfront_raw, b = ev.amount_total_raw;
  return [a, b].filter(Boolean).join(' / ') || (ev.amount_total_raw || '');
}
function summaryOf(ev) {
  const bits = [];
  if (ev.territory_raw) bits.push(ev.territory_raw);
  if (ev.asset_raw) bits.push(ev.asset_raw);
  return (bits.join('｜') || '').slice(0, 200);
}

function rowValues(ev) {
  const phase = (PHASE_MAP.find(([re]) => re.test(String(ev.phase_raw || ''))) || [])[1] || '';
  return {
    '事件键': W.V.text(ev.key),
    '事件日期': W.V.date(ev.date),
    '类型': S('类型', TYPE_MAP[ev.type] || '合作'),
    '中国公司': W.V.text(ev.company_raw || ''),
    '对方': W.V.text(ev.counterparty_raw || ''),
    '资产/代号': W.V.text(ev.asset_raw || ''),
    '阶段': S('阶段', phase),
    '金额': W.V.text(targetText(ev)),
    '摘要': W.V.text(summaryOf(ev)),
    '来源': ev.sources?.[0]?.url ? W.V.url(ev.sources[0].title?.slice(0, 40) || '原文', ev.sources[0].url) : ''
  };
}

const scalarOf = (title, v) => {
  const f = SCHEMA.find(x => x.field_title === title);
  if (!f) return String(W.plain(v) ?? '');
  if (f.field_type === 'FIELD_TYPE_URL') return String(v?.[0]?.link || '');
  if (f.field_type === 'FIELD_TYPE_SINGLE_SELECT') return String(W.plain(v) || '');
  if (f.field_type === 'FIELD_TYPE_DATE_TIME') return String(W.plain(v) || '');
  if (f.field_type === 'FIELD_TYPE_USER') return JSON.stringify((v || []).map(x => x.user_id || x.id));
  return String(W.plain(v) ?? '');
};

async function initTable() {
  const cfg = readCfg();
  if (!cfg.docid || !cfg.sheet_id) throw new Error(`缺 ${path.relative(WS, cfgFile())}（docid/sheet_id）`);
  const have = new Map(((await W.sheet.getFields(cfg.docid, cfg.sheet_id)).fields || []).map(f => [f.field_title, f]));
  const texts = [...have.values()].filter(f => f.field_type === 'FIELD_TYPE_TEXT');
  // 默认空表只有一个「智能表列」→ 改名为「事件键」；再倒序补其余列（add_fields 前插）
  if (!have.has('事件键') && texts.length) {
    await W.sheet.updateFields(cfg.docid, cfg.sheet_id, [{ field_id: texts[0].field_id, field_title: '事件键', field_type: texts[0].field_type }]);
  }
  const extra = [...have.values()].filter(f => f.field_type !== 'FIELD_TYPE_TEXT' && !SCHEMA.some(s => s.field_title === f.field_title));
  if (extra.length) await W.sheet.deleteFields(cfg.docid, cfg.sheet_id, extra.map(f => f.field_id));
  const add = SCHEMA.filter(f => f.field_title !== '事件键' && !have.has(f.field_title)).reverse();
  if (add.length) await W.sheet.addFields(cfg.docid, cfg.sheet_id, add);
  log(`子表就绪：字段 ${SCHEMA.length} 列（新增 ${add.length}）`);
  return readCfg();
}

async function sync(rows, { dryRun = false, windowDays = 60 } = {}) {
  const cfg = W.guardWrite('sync-preclinical');       // 跨环境/跨机写入直接拒绝
  if (!cfg.sheet_id) throw new Error('先跑 sync.js --init');
  log(`目标子表: env=${W.envOf()} host=${require('os').hostname()} docid=${cfg.docid.slice(0, 12)}… sheet=${cfg.sheet_id}`);

  const since = new Date(Date.now() - windowDays * 864e5).toISOString().slice(0, 10);
  const keep = rows.filter(r => (r.date || '') >= since);
  loadOpts((await W.sheet.getFields(cfg.docid, cfg.sheet_id)).fields);
  const records = await W.sheet.getRecords(cfg.docid, cfg.sheet_id);
  const existing = new Map(records.map(r => [W.plain(r.values?.['事件键']), r]).filter(([k]) => k));

  const toAdd = [], toUpdate = [];
  for (const r of keep) {
    const values = rowValues(r);
    const rec = existing.get(r.key);
    if (!rec) { toAdd.push({ values }); continue; }
    const changed = {};
    for (const t of DATA) {
      const v = values[t];
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
      if (scalarOf(t, rec.values?.[t]) !== scalarOf(t, values[t])) changed[t] = values[t];
    }
    if (Object.keys(changed).length) toUpdate.push({ record_id: rec.record_id, values: changed });
  }
  const keepKeys = new Set(keep.map(r => r.key));
  const hasFb = (rec) => !!(W.plain(rec.values?.['跟进状态']) || W.plain(rec.values?.['备注']) || (rec.values?.['负责人'] || []).length || W.plain(rec.values?.['是否已有客户']));
  const toDelete = [...existing.entries()].filter(([k, rec]) => !keepKeys.has(k) && !hasFb(rec)).map(([, rec]) => rec.record_id);

  // 缩表护栏：保留行腰斩 → 多半是账本缺失/跨年/损坏，拒绝写（跨年时 sync.js 已合并两年账本）
  const keepCount = keep.length + [...existing.keys()].filter(k => !keepKeys.has(k) && hasFb(existing.get(k))).length;
  if (records.length && keepCount < records.length * 0.5 && process.env.WECOM_ALLOW_SHRINK !== '1') {
    throw new Error(`拒绝同步：本轮保留 ${keepCount} 行，不足表内 ${records.length} 行的一半（账本缺失/跨年？）。确属口径调整则 WECOM_ALLOW_SHRINK=1 重跑`);
  }

  if (dryRun) { log(`[dry-run] 新增 ${toAdd.length} / 更新 ${toUpdate.length} / 移出 ${toDelete.length}（表内 ${records.length}）`); return { added: toAdd.length, updated: toUpdate.length, deleted: toDelete.length }; }
  if (toAdd.length) await W.sheet.addRecords(cfg.docid, cfg.sheet_id, toAdd);
  if (toUpdate.length) await W.sheet.updateRecords(cfg.docid, cfg.sheet_id, toUpdate);
  if (toDelete.length) await W.sheet.deleteRecords(cfg.docid, cfg.sheet_id, toDelete);
  log(`子表：新增 ${toAdd.length} / 更新 ${toUpdate.length} / 移出 ${toDelete.length} | 现 ${records.length - toDelete.length + toAdd.length} 行`);
  return { added: toAdd.length, updated: toUpdate.length, deleted: toDelete.length, total: records.length - toDelete.length + toAdd.length };
}

module.exports = { SCHEMA, FB, DATA, initTable, sync, rowValues, scalarOf, loadOpts, readCfg, cfgFile };