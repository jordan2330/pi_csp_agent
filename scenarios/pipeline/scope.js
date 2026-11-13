#!/usr/bin/env node
/**
 * 管线场景 —— 队列口径 + 公司名归一（纯函数，无浏览器依赖）
 *
 * 口径（2026-11-11 与销售确认）：
 *   - 只要化药（中药砍掉）
 *   - 注册分类 1 类 / 2.x 类（创新 + 改良型新药；3/4 类仿制、5.x 已上市进口不进）
 *   - 申请类型 = 新药 | 进口（补充申请/进口再注册是已上市品种的变更，属"事件"不属"新资产"）
 *
 * 归一策略：**保守**。只做机械可判的等价（法人后缀、括号、空白、全半角），
 *   不做模糊匹配合并 —— 错并两家公司会让销售反馈互相覆盖，比多两行更糟。
 *
 * 用法：
 *   node scenarios/pipeline/scope.js            # 只报告：越界行 + 可归并行
 *   node scenarios/pipeline/scope.js --apply    # 就地裁剪 + 归并 output/history/pipeline-cde.json
 */

const fs = require('fs');
const path = require('path');

const WS = path.resolve(__dirname, '..', '..');
const STORE = path.join(WS, 'output', 'history', 'pipeline-cde.json');
const ALIAS_FILE = path.join(WS, 'config', 'company-aliases.json');

function loadScope() {
  try { return JSON.parse(fs.readFileSync(path.join(WS, 'config', 'pipeline-scope.json'), 'utf8')); }
  catch { return { drug_type: '化药', apply_type: ['新药', '进口'], reg_class: ['1', '2.x'], exclude_import: false }; }
}
const IN_SCOPE_TYPE = '化药';
const APPLY = new Set(['新药', '进口']);
const NEW_CLASS = /^(1|2)(\.[0-9])?$/;
const PLACEHOLDER = /^(无|不适用|N\/A|-|\/|—)$/i;

function inScope(r) {
  const cfg = loadScope();
  if ((r.drugType || '') !== IN_SCOPE_TYPE) return false;
  if (!new Set(cfg.apply_type || ['新药', '进口']).has(r.applyType)) return false;
  // 进口受理号（J 开头）= 境外主体持证资产，不是我们要跟的中国自研/自产机会
  if (cfg.exclude_import && /^J/.test(String(r.regNo || ''))) return false;
  if (PLACEHOLDER.test(String(r.company || '').trim())) return false;
  // 注册分类：配置里的 "1" / "2.x"（缺省 1+2.x）
  const cls = String(r.regClass || '').replace(/类$/, '');
  const allow = new Set((cfg.reg_class || ['1', '2.x']).map(String));
  if (allow.has('2.x') ? NEW_CLASS.test(cls) : allow.has(cls)) return true;
  return allow.has(cls);
}

function loadAliases() {
  try { return JSON.parse(fs.readFileSync(ALIAS_FILE, 'utf8')); } catch { return { aliases: {}, blocklist: [] }; }
}

// 备注型括号剥离：CDE 公司字段里混着「生产/包装说明」括号
//   （如「江苏豪森药业集团有限公司(预填充注射笔的组装和最终成品包装: 江苏恒瑞医药股份有限公司)」），
//   它不属于主体名。只剥机械可判的：括号内出现冒号（说明型），或内容超过 16 字（成句说明）。
//   短括号「（北京）/（中国）」与 `;` 分隔的多主体列表一律保留 —— 错并两家比多两行更糟（华辉安健误并事故）。
// shortcut: 不处理嵌套括号（CDE 未出现），遇到再补。
function stripRemarkParen(name) {
  return String(name || '').replace(/[（(]([^（()）]*)[）)]/g, (m, inner) => {
    if (/[;；]/.test(inner)) return m;
    return /:|：/.test(inner) || inner.trim().length > 16 ? '' : m;
  }).trim();
}

// 机械归一：去法人后缀/括号内容/空白标点，拉丁字母大写
function normalize(name) {
  return String(name || '')
    .replace(/[（(]\s*(中国|China)\s*[）)]/gi, '')            // 只去掉 (中国)/(China)，其余括号常含分支/主体信息，保留
    .replace(/(股份有限公司|有限责任公司|有限公司|集团股份|股份公司|公司|集团|控股)/g, '')
    .replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '')
    .toUpperCase();
}

// 别名表优先，其次机械归一
function companyKey(name) {
  const { aliases = {} } = loadAliases();
  const hit = Object.keys(aliases).find(canon => (aliases[canon] || []).some(a => a === name));
  if (hit) return normalize(hit);
  return normalize(name);
}

// 就地裁剪 + 归并：按 (companyKey, 归一药品名) 判重，但**落盘键用原始 `公司|药名`**
//   与 sources-cde.js / sync.js 同口径（否则同一资产存成两行，表里长出重复商机键）。
// 剥括号备注后的公司名写回 company，原值留在 company_raw。
function applyToStore(store) {
  const kept = {}, index = new Map(), merged = [], dropped = [], stripped = [];
  for (const r of Object.values(store.rows || {})) {
    if (!inScope(r)) { dropped.push(r); continue; }
    const company = stripRemarkParen(r.company);
    if (company !== r.company) stripped.push(r.company);
    const nkey = `${companyKey(company)}|${normalize(r.drugName)}`;
    const key = index.get(nkey);
    if (!key) {
      const k = `${company}|${r.drugName}`;
      index.set(nkey, k);
      kept[k] = { ...r, company, company_raw: [...new Set([...(r.company_raw || []), r.company])] };
      continue;
    }
    const prev = kept[key];
    merged.push([prev.company, company]);
    prev.company_raw = [...new Set([...prev.company_raw, ...(r.company_raw || []), r.company])];
    if (r.first_seen && (!prev.first_seen || r.first_seen < prev.first_seen)) prev.first_seen = r.first_seen;
    if (r.last_seen && (!prev.last_seen || r.last_seen > prev.last_seen)) prev.last_seen = r.last_seen;
    if ((r.phase_rank || 0) > (prev.phase_rank || 0)) { prev.phase = r.phase; prev.phase_rank = r.phase_rank; prev.nct = r.nct; prev.phase_src = r.phase_src; }
    if (!prev.reg_no && r.regNo) prev.reg_no = r.regNo;
    prev.reg_nos = [...new Set([...(prev.reg_nos || [prev.regNo].filter(Boolean)), r.regNo].filter(Boolean))];
  }
  store.rows = kept;
  // 越界行归档：改口径（如把进口加回来）时不必重扫 CDE
  if (dropped.length) {
    store.dropped = store.dropped || {};
    for (const r of dropped) store.dropped[`${r.company}|${r.drugName}`] = { ...r, dropped_at: new Date().toISOString().slice(0, 10) };
  }
  return { before: Object.keys(kept).length, dropped: dropped.length, merged: merged.length, mergedPairs: merged.slice(0, 10), stripped };
}

module.exports = { inScope, normalize, stripRemarkParen, companyKey, loadAliases, applyToStore };

if (require.main === module) {
  const assert = require('assert');
  // 口径自检
  assert.equal(inScope({ drugType: '化药', applyType: '新药', regClass: '1类', company: 'X药业' }), true);
  assert.equal(inScope({ drugType: '化药', applyType: '新药', regClass: '2.4', company: 'X药业' }), false);   // 当前口径只要创新药(1 类)，2.x 改良型不进
  assert.equal(inScope({ drugType: '化药', applyType: '进口', regClass: '1', company: 'X Pharma', regNo: 'JXHL2600001' }), false);   // 进口已按 config 排除
  assert.equal(inScope({ drugType: '化药', applyType: '进口', regClass: '1', company: 'X药业', regNo: 'CXHL2600001' }), false);  // 当前口径只要新药申请，进口整类不进
  assert.equal(inScope({ drugType: '中药', applyType: '新药', regClass: '1.1类', company: 'X药业' }), false);
  assert.equal(inScope({ drugType: '化药', applyType: '补充申请', regClass: '1类', company: 'X药业' }), false);
  assert.equal(inScope({ drugType: '化药', applyType: '新药', regClass: '3类', company: 'X药业' }), false);
  assert.equal(inScope({ drugType: '化药', applyType: '新药', regClass: '1类', company: '不适用' }), false);
  // 归一自检
  assert.equal(normalize('江苏恒瑞医药股份有限公司'), normalize('江苏恒瑞医药有限公司'));
  assert.notEqual(normalize('江苏恒瑞医药股份有限公司'), normalize('江苏豪森药业集团有限公司'));
  // 括号备注剥离：只剥说明型（冒号 / >16 字），短括号与多主体列表保留
  assert.equal(stripRemarkParen('江苏豪森药业集团有限公司(预填充注射笔的组装和最终成品包装: 江苏恒瑞医药股份有限公司)'), '江苏豪森药业集团有限公司');
  assert.equal(stripRemarkParen('华辉安健（北京）生物科技有限公司'), '华辉安健（北京）生物科技有限公司');
  assert.equal(stripRemarkParen('远大医药（中国）有限公司'), '远大医药（中国）有限公司');
  assert.equal(stripRemarkParen('A药业（B公司;C公司）'), 'A药业（B公司;C公司）');                       // 多主体列表保留
  assert.equal(stripRemarkParen('A药业（这一段括号内容明显超过十六个字符属于成句说明）'), 'A药业');
  // 落盘键 = 原始 公司|药名（与 sources-cde / sync 一致），判重仍按归一键
  {
    const store = { rows: {
      'X药业|同一资产片': { company: 'X药业', drugName: '同一资产片', drugType: '化药', applyType: '新药', regClass: '1', last_seen: '2026-01-01' },
      'X药业(委托生产: Y公司)|同一资产片': { company: 'X药业(委托生产: Y公司)', drugName: '同一资产片', drugType: '化药', applyType: '新药', regClass: '1', last_seen: '2026-02-01' }
    } };
    const out = applyToStore(store);
    assert.deepEqual(Object.keys(store.rows), ['X药业|同一资产片']);
    assert.equal(store.rows['X药业|同一资产片'].last_seen, '2026-02-01');
    assert.deepEqual(store.rows['X药业|同一资产片'].company_raw, ['X药业', 'X药业(委托生产: Y公司)']);
    assert.equal(out.merged, 1);
  }

  const apply = process.argv.includes('--apply');
  let store;
  try { store = JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch (e) { console.error(`❌ 读不到 ${path.relative(WS, STORE)}: ${e.message}`); process.exit(1); }
  const before = Object.keys(store.rows || {}).length;
  const r = applyToStore(store);
  console.log(`归并前 ${before} 行 → 口径内 ${r.before} 行 | 越界剔除 ${r.dropped} | 重复归并 ${r.merged}`);
  if (r.mergedPairs.length) {
    console.log('归并样例:', r.mergedPairs.map(([a, b]) => `${a} + ${b}`).join(' ; '));
  }
  if (r.stripped.length) console.log('括号备注剥离:', r.stripped.join(' ; '));
  if (!apply) { console.log('(dry-run，加 --apply 落盘)'); process.exit(0); }
  const eff = loadScope();
  store.scope = {
    drug_type: IN_SCOPE_TYPE, reg_class: '1|2.x',
    apply_type: eff.apply_type || [...APPLY], exclude_import: !!eff.exclude_import,
    applied_at: new Date().toISOString()
  };
  fs.writeFileSync(STORE, JSON.stringify(store, null, 1));
  console.log(`✅ 已写入 ${path.relative(WS, STORE)}`);
}