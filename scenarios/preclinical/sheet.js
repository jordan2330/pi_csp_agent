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
const { match } = require('./lib/match');

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

const NUM = (t) => ({ field_title: t, field_type: 'FIELD_TYPE_NUMBER', property_number: { decimal_places: 1, use_separator: false } });

const SCHEMA = [
  { field_title: '事件键', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '事件日期', field_type: 'FIELD_TYPE_DATE_TIME', property_date_time: { format: 'yyyy-mm-dd' } },
  { field_title: '类型', field_type: 'FIELD_TYPE_SINGLE_SELECT', property_single_select: { options: [sel('授权出海', 12), sel('引进', 9), sel('融资', 11), sel('里程碑', 16), sel('合作', 20)] } },
  { field_title: '中国公司', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '对方', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '对方类型', field_type: 'FIELD_TYPE_SINGLE_SELECT', property_single_select: { options: [sel('MNC', 12), sel('中国药企', 9), sel('投资机构', 16), sel('NewCo', 11), sel('CDMO', 20), sel('其他', 16)] } },
  { field_title: '资产/代号', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '剂型', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '治疗领域', field_type: 'FIELD_TYPE_SINGLE_SELECT', property_single_select: { options: [sel('肿瘤', 12), sel('自免/炎症', 9), sel('代谢/减重', 11), sel('CNS', 16), sel('呼吸', 16), sel('感染/疫苗', 20), sel('心血管/肾病', 20), sel('眼科', 20), sel('其他', 20), sel('未知', 20)] } },
  { field_title: '阶段', field_type: 'FIELD_TYPE_SINGLE_SELECT', property_single_select: { options: [sel('临床前', 12), sel('IND', 9), sel('I期', 16), sel('II期', 16), sel('III期', 11), sel('NDA/上市', 20)] } },
  NUM('首付款(百万美元)'),
  NUM('交易总额(百万美元)'),
  { field_title: '金额原文', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '授权范围', field_type: 'FIELD_TYPE_SINGLE_SELECT', property_single_select: { options: [sel('全球', 12), sel('大中华区以外', 9), sel('含大中华区', 11), sel('区域性', 16), sel('未知', 20)] } },
  { field_title: '中国权益', field_type: 'FIELD_TYPE_SINGLE_SELECT', property_single_select: { options: [sel('保留', 11), sel('已授出', 16), sel('未知', 20)] } },
  { field_title: '摘要', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '已在资产表', field_type: 'FIELD_TYPE_SINGLE_SELECT', property_single_select: { options: [sel('是', 11), sel('否', 16)] } },
  { field_title: '来源', field_type: 'FIELD_TYPE_URL', property_url: { type: 'LINK_TYPE_ICON_TEXT' } },
  // ↓ 销售独占写
  { field_title: '是否已有客户', field_type: 'FIELD_TYPE_SINGLE_SELECT', property_single_select: { options: [sel('是', 11), sel('否', 16), sel('待确认', 20)] } },
  { field_title: '跟进状态', field_type: 'FIELD_TYPE_SINGLE_SELECT', property_single_select: { options: [sel('未跟进', 20), sel('已联系', 12), sel('跟进中', 9), sel('已成交', 11), sel('放弃', 16)] } },
  { field_title: '负责人', field_type: 'FIELD_TYPE_USER' },
  { field_title: '备注', field_type: 'FIELD_TYPE_TEXT' }
];

const FB = ['是否已有客户', '跟进状态', '负责人', '备注'];
const DATA = SCHEMA.map(f => f.field_title).filter(t => !FB.includes(t));
// 剂型：LLM 抽到就用；抽不到时从资产名/标题里按词表兜底（「HSK47388片」「SIM0725注射液」）
const FORM_RE = /(注射液|注射剂|冻干粉针|粉针剂|预灌封注射器|输液|片剂|缓释片|控释片|肠溶片|分散片|咀嚼片|口崩片|口溶膜|胶囊|软胶囊|缓释胶囊|肠溶胶囊|颗粒剂|颗粒|散剂|口服溶液|口服液|混悬液|干混悬剂|糖浆|合剂|鼻喷雾剂|喷雾剂|气雾剂|吸入粉雾剂|吸入剂|滴眼液|眼用凝胶|滴鼻液|乳膏|软膏|凝胶剂|贴剂|贴片|栓剂|滴丸|皮下注射|静脉注射)/;
const dosageForm = (ev) => ev.dosage_form_raw || (String(ev.asset_raw || '').match(FORM_RE) || [])[0] || (String(ev.sources?.[0]?.title || '').match(FORM_RE) || [])[0] || '';

const SCOPE_MAP = { global: '全球', ex_greater_china: '大中华区以外', greater_china: '含大中华区', regional: '区域性', unknown: '未知' };
const RIGHTS_MAP = { retained: '保留', excluded: '已授出', unknown: '未知' };
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
  return (a && b && a === b) ? a : [a, b].filter(Boolean).join(' / ');
}
function summaryOf(ev) {
  return (ev.one_liner || [ev.territory_raw, ev.asset_raw].filter(Boolean).join('｜') || '').slice(0, 200);
}

function rowValues(ev) {
  const phase = (PHASE_MAP.find(([re]) => re.test(String(ev.phase_raw || ''))) || [])[1] || '';
  return {
    '事件键': W.V.text(ev.key),
    '事件日期': W.V.date(ev.date),
    '类型': S('类型', TYPE_MAP[ev.type] || '合作'),
    '中国公司': W.V.text(ev.company_raw || ''),
    '对方': W.V.text(ev.counterparty_raw || ''),
    '对方类型': S('对方类型', ev.counterparty_type || '其他'),
    '资产/代号': W.V.text(ev.asset_raw || ''),
    '剂型': W.V.text(dosageForm(ev)),
    '治疗领域': S('治疗领域', ev.therapeutic_area || '未知'),
    '阶段': S('阶段', phase),
    '首付款(百万美元)': ev.amount_upfront_usd_m ?? '',
    '交易总额(百万美元)': ev.amount_total_usd_m ?? '',
    '金额原文': W.V.text(targetText(ev)),
    '授权范围': S('授权范围', SCOPE_MAP[ev.territory_scope] || '未知'),
    '中国权益': S('中国权益', RIGHTS_MAP[ev.china_rights] || '未知'),
    '摘要': W.V.text(summaryOf(ev)),
    '已在资产表': S('已在资产表', match(ev).hit),
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
  if (process.env.PRECLINICAL_REBUILD === '1') {
    // 重建：add_fields 是前插，改列顺序只能清空重来（行由账本重建；销售未填反馈时才可用）
    const recs = await W.sheet.getRecords(cfg.docid, cfg.sheet_id);
    if (recs.some(r => r.values?.['跟进状态'] || r.values?.['备注'])) throw new Error('表里已有销售反馈，拒绝重建（会丢反馈）');
    if (recs.length) await W.sheet.deleteRecords(cfg.docid, cfg.sheet_id, recs.map(r => r.record_id));
    // 实测：一次删光全部字段会报 2000055，且主字段不能删 → 留第一个，其余分批（5 个一批）删
    const flds = (await W.sheet.getFields(cfg.docid, cfg.sheet_id)).fields || [];
    for (let i = 1; i < flds.length; i += 5) {
      await W.sheet.deleteFields(cfg.docid, cfg.sheet_id, flds.slice(i, i + 5).map(f => f.field_id));
      await new Promise(r => setTimeout(r, 800));
    }
    await W.sheet.addFields(cfg.docid, cfg.sheet_id, SCHEMA.filter(f => f.field_title !== '事件键').slice().reverse());
    const t = (await W.sheet.getFields(cfg.docid, cfg.sheet_id)).fields.find(f => f.field_type === 'FIELD_TYPE_TEXT');
    await W.sheet.updateFields(cfg.docid, cfg.sheet_id, [{ field_id: t.field_id, field_title: '事件键', field_type: t.field_type }]);
    log(`子表已重建：${SCHEMA.length} 列`);
    return readCfg();
  }
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