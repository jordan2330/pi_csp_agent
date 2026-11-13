#!/usr/bin/env node
/**
 * 管线场景交付层 —— 第二张表「CSP管线商机」
 *
 * 与主表（nitrosamine 的「CSP商机跟踪」）**完全独立**：自己的 SCHEMA / 行模型 / 反馈账本。
 * 为什么不复用 37 列：管线行没有 API/试验/登记号语义，那些列会是空或假值（见 PLAN.md）。
 *
 * 表格字段 ≤20：判断价值（档位/总分/三处分）→ 客户与资产 → 溯源 → 反馈 4 列（销售独占写）
 * 系统 4 列（创建人/时间、最后编辑人/时间）由企微自动维护。
 *
 * 目标表由 WECOM_TABLE=pipeline + WECOM_ENV 决定：
 *   config/wecom-pipeline.json（prod）/ config/wecom-pipeline.dev.json（dev）
 *
 * 用法（经 sync.js 调用，勿直接用）：见 scenarios/pipeline/sync.js
 */

const fs = require('fs');
const path = require('path');
const W = require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'wecom.js'));

const WS = path.resolve(__dirname, '..', '..');
const log = (...a) => console.log(...a);
const FB_FILE = path.join(WS, 'output', 'history', 'feedback-pipeline.json');
const T_BASE = 'CSP管线商机';

// 数值单元格必须写裸数字（实测 [{type:'number'}] 与 [{number}] 都会被丢弃，读回 undefined）
const NUMBER = (n) => (n == null || n === '' ? '' : Number(n));
const sel = (text, style) => ({ text, style });
const NUM = (title) => ({ field_title: title, field_type: 'FIELD_TYPE_NUMBER', property_number: { decimal_places: 0, use_separator: false } });

// ── 20 列：顺序 = 销售阅读顺序（左→右）；add_fields 是前插，建表时倒序添加 ──
const SCHEMA = [
  { field_title: '商机键', field_type: 'FIELD_TYPE_TEXT' },                                      // 主字段，= PIPE|公司|资产
  { field_title: '档位', field_type: 'FIELD_TYPE_SINGLE_SELECT', property_single_select: { options: [sel('A-本周跟', 12), sel('B-培育', 9), sel('C-观察', 16), sel('D-不进表', 20)] } },
  NUM('总分'),
  { field_title: '公司', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '资产/药品名', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '剂型', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '期次', field_type: 'FIELD_TYPE_SINGLE_SELECT', property_single_select: { options: [sel('I期', 16), sel('II期', 9), sel('III期/NDA', 12), sel('无期次', 20)] } },
  { field_title: '注册分类', field_type: 'FIELD_TYPE_TEXT' },
  NUM('D1剂型分'),
  NUM('D2理化分'),
  NUM('D3期次分'),
  { field_title: '评分依据', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '最近受理日', field_type: 'FIELD_TYPE_DATE_TIME', property_date_time: { format: 'yyyy-mm-dd' } },
  { field_title: '首次发现', field_type: 'FIELD_TYPE_DATE_TIME', property_date_time: { format: 'yyyy-mm-dd' } },
  { field_title: '登记号', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '详情链接', field_type: 'FIELD_TYPE_URL', property_url: { type: 'LINK_TYPE_ICON_TEXT' } },   // URL 字段必须带 property_url（实测缺它报 2022019）
  { field_title: '跟进状态', field_type: 'FIELD_TYPE_SINGLE_SELECT', property_single_select: { options: [sel('待跟进', 16), sel('跟进中', 9), sel('已联系', 12), sel('不感兴趣', 20), sel('已转化', 21)] } },
  { field_title: '负责人', field_type: 'FIELD_TYPE_USER' },
  { field_title: '跟进备注', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '跟进日期', field_type: 'FIELD_TYPE_DATE_TIME', property_date_time: { format: 'yyyy-mm-dd' } }
];
const FEEDBACK_TITLES = ['跟进状态', '负责人', '跟进备注', '跟进日期'];
const DATA_TITLES = SCHEMA.map(f => f.field_title).filter(t => !FEEDBACK_TITLES.includes(t));

// ── 建表（幂等）──
async function initTable() {
  const old = W.readCfg();
  if (old.docid && old.sheet_id && old.official) {
    if (!old.env || !old.host) W.writeCfg(old);
    // 幂等补齐：字段丢了/列名改了也能自愈（add_fields 前插 → 倒序添加）
    const have = new Set(((await W.sheet.getFields(old.docid, old.sheet_id)).fields || []).map(f => f.field_title));
    const missing = SCHEMA.filter(f => !have.has(f.field_title)).slice().reverse();
    if (missing.length) {
      await W.sheet.addFields(old.docid, old.sheet_id, missing);
      log(`补齐 ${missing.length} 个字段`);
    }
    log(`表已存在: ${old.url}`);
    return old;
  }
  const env = W.envOf();
  const docName = env === 'prod' ? T_BASE : `${T_BASE}-${env}`;
  log(`创建智能表格: ${docName}`);
  const doc = await W.sheet.createDoc(docName);
  const docid = doc.docid || doc.doc_id;
  const url = doc.url || `https://doc.weixin.qq.com/smartsheet/${docid}`;
  const sheets = await W.sheet.getSheets(docid);
  const sheetId = (sheets.sheet_list || sheets.sheets || [])[0]?.sheet_id;
  if (!sheetId) throw new Error(`未取到子表 ID: ${JSON.stringify(sheets).slice(0, 300)}`);

  // 先落 cfg：后面任何一步失败，重跑都复用这张表，不会重复建表
  W.writeCfg({ docid, sheet_id: sheetId, url, official: true, created_at: new Date().toISOString() });

  // 默认字段：主字段改名承接「商机键」，其余默认列删掉；新建表的空记录也清掉
  const def = (await W.sheet.getFields(docid, sheetId)).fields || [];
  const texts = def.filter(f => f.field_type === 'FIELD_TYPE_TEXT');
  const others = def.filter(f => f.field_type !== 'FIELD_TYPE_TEXT');
  if (texts.length) {
    await W.sheet.updateFields(docid, sheetId, [{ field_id: texts[0].field_id, field_title: '商机键', field_type: texts[0].field_type }]);
    if (others.length) await W.sheet.deleteFields(docid, sheetId, others.map(f => f.field_id));
  }
  const empties = (await W.sheet.getRecords(docid, sheetId)).filter(r => !W.plain(r.values?.['商机键']));
  if (empties.length) await W.sheet.deleteRecords(docid, sheetId, empties.map(r => r.record_id));

  // add_fields 前插 → 倒序添加，UI 左→右才是 SCHEMA 顺序（v5.2.0 已修同类缺陷，此处照抄）
  await W.sheet.addFields(docid, sheetId, SCHEMA.filter(f => f.field_title !== '商机键').slice().reverse());
  log(`✅ 表就绪: ${url}`);
  return { docid, sheet_id: sheetId, url };
}

// ── 行值 ──
const S = (title, text) => {
  const f = SCHEMA.find(x => x.field_title === title);
  const opt = (f?.property_single_select?.options || []).find(o => o.text === text);
  return opt ? [{ id: opt.id, text: opt.text }] : [];
};
// 登记号 = 该资产**全部**受理号（升序，最多 3 个，超出用 `+N` 收尾）。
// 只影响展示：商机键仍由 sync.js 用 `company|drugName` 生成，与受理号无关。
function regNosText(r) {
  const all = [...new Set([...(r.reg_nos || []), r.regNo, r.reg_no].filter(Boolean))].sort();
  return all.length > 3 ? `${all.slice(0, 3).join(',')} +${all.length - 3}` : all.join(',');
}
function rowValues(r) {
  return {
    '商机键': W.V.text(r.key),
    '档位': S('档位', r.tier === 'A' ? 'A-本周跟' : r.tier === 'B' ? 'B-培育' : r.tier === 'C' ? 'C-观察' : 'D-不进表'),
    '总分': NUMBER(r.points),
    '公司': W.V.text(r.company),
    '资产/药品名': W.V.text(r.drugName),
    '剂型': W.V.text(r.form || ''),
    '期次': S('期次', r.phase || '无期次'),
    '注册分类': W.V.text(r.regClass || ''),
    'D1剂型分': NUMBER(r.dims?.D1 ?? 0),
    'D2理化分': NUMBER(r.dims?.D2 ?? 0),
    'D3期次分': NUMBER(r.dims?.D3 ?? 0),
    '评分依据': W.V.text((r.notes || []).join('；')),
    '最近受理日': W.V.date(r.last_seen || r.date),
    '首次发现': W.V.date(r.first_seen),
    '登记号': W.V.text(regNosText(r)),
    '详情链接': r.nct ? W.V.url(r.nct, `https://clinicaltrials.gov/study/${r.nct}`) : []
  };
}

// ── 值比较（避免结构噪声导致每次都 update；新增字段类型必须在这里加 case）──
function scalarOf(field, val) {
  if (val == null || val === '') return '';
  switch (field.field_type) {
    case 'FIELD_TYPE_TEXT': return W.plain(val);
    case 'FIELD_TYPE_URL': return Array.isArray(val) ? (val[0]?.link || '') : '';
    case 'FIELD_TYPE_DATE_TIME': return String(new Date(Number(val)).toISOString().slice(0, 10));
    case 'FIELD_TYPE_SINGLE_SELECT': return Array.isArray(val) ? (val[0]?.text || '') : '';
    case 'FIELD_TYPE_NUMBER': return Array.isArray(val) ? String(val[0]?.number ?? '') : String(val);
    default: return W.plain(val);
  }
}

// ── 反馈拉回（销售独占写的 4 列 → 事件账本）──
function loadFeedback() { try { return JSON.parse(fs.readFileSync(FB_FILE, 'utf8')); } catch { return { current: {}, history: [] }; } }
function pullFeedback(records) {
  const fb = loadFeedback();
  const changes = [];
  for (const rec of records) {
    const key = W.plain(rec.values?.['商机键']);
    if (!key) continue;
    const cur = {
      status: W.plain(rec.values?.['跟进状态']),
      owner: (rec.values?.['负责人'] || []).map(u => u.user_id).filter(Boolean).join(','),
      note: W.plain(rec.values?.['跟进备注']),
      fdate: rec.values?.['跟进日期'] ? new Date(Number(rec.values['跟进日期'])).toISOString().slice(0, 10) : ''
    };
    if (!cur.status && !cur.owner && !cur.note && !cur.fdate) continue;
    const prev = fb.current[key];
    if (prev && prev.status === cur.status && prev.owner === cur.owner && prev.note === cur.note && prev.fdate === cur.fdate) continue;
    const ev = { ...cur, by: rec.updater_name || '（未知）', at: rec.update_time ? new Date(Number(rec.update_time)).toISOString().slice(0, 16).replace('T', ' ') : '' };
    fb.current[key] = ev;
    fb.history.push({ key, ...ev });
    changes.push({ key, ...ev });
  }
  if (changes.length) {
    fs.mkdirSync(path.dirname(FB_FILE), { recursive: true });
    fs.writeFileSync(FB_FILE, JSON.stringify(fb, null, 1));
  }
  return changes;
}

// ── 不变量自检：宁可空，不可把矛盾组合写进销售看的表 ──
function checkRows(rows) {
  const bad = [];
  for (const r of rows) {
    if (!r.key || !/^PIPE\|.+\|.+$/.test(r.key)) bad.push([r.key, '商机键格式']);
    // 权重必须与 scoring.js 一致：D1/D2/D4 各 ×2，其余 ×1
    const expect = 2 * (r.dims?.D1 ?? 0) + 2 * (r.dims?.D2 ?? 0) + (r.dims?.D3 ?? 0)
      + 2 * (r.dims?.D4 ?? 0) + (r.dims?.D5 ?? 0) + (r.dims?.D6 ?? 0) + (r.dims?.D7 ?? 0);
    if (r.points !== expect) bad.push([r.key, `总分=${r.points} 与各维之和=${expect} 不符`]);
    if (r.phase && (r.dims?.D3 ?? 0) === 0) bad.push([r.key, `有期次(${r.phase})但 D3=0`]);
    if (!r.phase && (r.dims?.D3 ?? 0) > 0) bad.push([r.key, '无期次但 D3>0']);
  }
  return bad;
}

// ── 同步（增量 upsert + 移出表 + 反馈拉回）──
async function sync(rows, { dryRun = false } = {}) {
  const cfg = W.guardWrite('sync-pipeline');
  if (!dryRun) log(W.targetLine(cfg));
  const bad = checkRows(rows);
  for (const [k, why] of bad) console.error(`  ⚠️ 自检: ${k} — ${why}`);
  const clean = rows.filter(r => !bad.some(([k]) => k === r.key));

  const fields = (await W.sheet.getFields(cfg.docid, cfg.sheet_id)).fields || [];
  const byTitle = new Map(fields.map(f => [f.field_title, f]));
  const records = await W.sheet.getRecords(cfg.docid, cfg.sheet_id);
  const existing = new Map();
  for (const rec of records) {
    const k = W.plain(rec.values?.['商机键']);
    if (k) existing.set(k, rec);
  }
  const fbChanges = pullFeedback(records);
  if (fbChanges.length) log(`销售反馈：${fbChanges.length} 条变化已入账`);

  const toAdd = [], toUpdate = [];
  for (const r of clean) {
    const values = rowValues(r);
    const rec = existing.get(r.key);
    if (!rec) { toAdd.push({ values }); continue; }
    const changed = {};
    for (const t of DATA_TITLES) {
      const v = values[t];
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;   // 0 要照写，别被 falsy 判掉
      const f = byTitle.get(t);
      if (!f) continue;
      if (scalarOf(f, rec.values?.[t]) !== scalarOf(f, values[t])) changed[t] = values[t];
    }
    if (Object.keys(changed).length) toUpdate.push({ record_id: rec.record_id, values: changed });
  }

  // 移出表：已有但本轮不在清单里的（有反馈的行永不删 —— 销售跟过的线索不消失）
  const keepKeys = new Set(clean.map(r => r.key));
  const hasFeedback = (rec) => !!(W.plain(rec.values?.['跟进状态']) || W.plain(rec.values?.['跟进备注']) || (rec.values?.['负责人'] || []).length || W.plain(rec.values?.['跟进日期']));
  const toDelete = [...existing.entries()].filter(([k, rec]) => !keepKeys.has(k) && !hasFeedback(rec)).map(([, rec]) => rec.record_id);

  // 缩表护栏：保留行数腰斩 → 多半是采集/筛选事故
  const keepCount = clean.length + [...existing.keys()].filter(k => !keepKeys.has(k) && hasFeedback(existing.get(k))).length;
  if (existing.size && keepCount < existing.size * 0.5 && process.env.WECOM_ALLOW_SHRINK !== '1') {
    throw new Error(`拒绝同步：本轮保留 ${keepCount} 行，不足表内 ${existing.size} 行的一半（疑似采集/筛选异常）。先看输出；确属口径调整则 WECOM_ALLOW_SHRINK=1 重跑`);
  }

  if (dryRun) {
    log(`[dry-run] 新增 ${toAdd.length} / 更新 ${toUpdate.length} / 移出 ${toDelete.length}（表内现有 ${existing.size}）`);
    return { added: toAdd.length, updated: toUpdate.length, deleted: toDelete.length, rows: keepCount, fbChanges: fbChanges.length };
  }
  if (toAdd.length) await W.sheet.addRecords(cfg.docid, cfg.sheet_id, toAdd);
  if (toUpdate.length) await W.sheet.updateRecords(cfg.docid, cfg.sheet_id, toUpdate);
  if (toDelete.length) await W.sheet.deleteRecords(cfg.docid, cfg.sheet_id, toDelete);
  log(`表内新增 ${toAdd.length} 行 / 更新 ${toUpdate.length} 行 / 移出 ${toDelete.length} 行 | 现 ${keepCount} 行`);
  return { added: toAdd.length, updated: toUpdate.length, deleted: toDelete.length, rows: keepCount, fbChanges: fbChanges.length, url: cfg.url };
}

module.exports = { SCHEMA, DATA_TITLES, FEEDBACK_TITLES, initTable, sync, rowValues, regNosText, scalarOf, checkRows, FB_FILE };

if (require.main === module) {
  const assert = require('assert');
  assert.equal(regNosText({ regNo: 'CXHL2601357', reg_nos: ['CXHL2601357', 'CXHL2600081'] }), 'CXHL2600081,CXHL2601357');
  assert.equal(regNosText({ regNo: 'CXHL2609999' }), 'CXHL2609999');
  assert.equal(regNosText({}), '');
  assert.equal(regNosText({ reg_nos: ['CXHL2600004', 'CXHL2600001', 'CXHL2600003', 'CXHL2600002', 'CXHL2600005'] }), 'CXHL2600001,CXHL2600002,CXHL2600003 +2');
  console.log('✅ 登记号展示自检通过');
}