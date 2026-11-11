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

const IN_SCOPE_TYPE = '化药';
const APPLY = new Set(['新药', '进口']);
const NEW_CLASS = /^(1|2)(\.[0-9])?$/;
const PLACEHOLDER = /^(无|不适用|N\/A|-|\/|—)$/i;

function inScope(r) {
  if ((r.drugType || '') !== IN_SCOPE_TYPE) return false;
  if (!APPLY.has(r.applyType)) return false;
  if (PLACEHOLDER.test(String(r.company || '').trim())) return false;
  const cls = String(r.regClass || '').replace(/类$/, '');
  return NEW_CLASS.test(cls);
}

function loadAliases() {
  try { return JSON.parse(fs.readFileSync(ALIAS_FILE, 'utf8')); } catch { return { aliases: {}, blocklist: [] }; }
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

// 就地裁剪 + 归并：同 (companyKey, 归一药品名) 合成一行，保留最早 first_seen / 最新 last_seen
function applyToStore(store) {
  const kept = {}, merged = [], dropped = [];
  for (const r of Object.values(store.rows || {})) {
    if (!inScope(r)) { dropped.push(r); continue; }
    const key = `${companyKey(r.company)}|${normalize(r.drugName)}`;
    const prev = kept[key];
    if (!prev) { kept[key] = { ...r, company_raw: [r.company] }; continue; }
    merged.push([prev.company, r.company]);
    prev.company_raw = [...new Set([...prev.company_raw, r.company])];
    if (r.first_seen && (!prev.first_seen || r.first_seen < prev.first_seen)) prev.first_seen = r.first_seen;
    if (r.last_seen && (!prev.last_seen || r.last_seen > prev.last_seen)) prev.last_seen = r.last_seen;
    if ((r.phase_rank || 0) > (prev.phase_rank || 0)) { prev.phase = r.phase; prev.phase_rank = r.phase_rank; prev.nct = r.nct; prev.phase_src = r.phase_src; }
    if (!prev.reg_no && r.regNo) prev.reg_no = r.regNo;
    prev.reg_nos = [...new Set([...(prev.reg_nos || [prev.regNo].filter(Boolean)), r.regNo].filter(Boolean))];
  }
  store.rows = kept;
  return { before: Object.keys(store.rows).length, dropped: dropped.length, merged: merged.length, mergedPairs: merged.slice(0, 10) };
}

module.exports = { inScope, normalize, companyKey, loadAliases, applyToStore };

if (require.main === module) {
  const assert = require('assert');
  // 口径自检
  assert.equal(inScope({ drugType: '化药', applyType: '新药', regClass: '1类', company: 'X药业' }), true);
  assert.equal(inScope({ drugType: '化药', applyType: '新药', regClass: '2.4', company: 'X药业' }), true);
  assert.equal(inScope({ drugType: '化药', applyType: '进口', regClass: '1', company: 'X Pharma' }), true);
  assert.equal(inScope({ drugType: '中药', applyType: '新药', regClass: '1.1类', company: 'X药业' }), false);
  assert.equal(inScope({ drugType: '化药', applyType: '补充申请', regClass: '1类', company: 'X药业' }), false);
  assert.equal(inScope({ drugType: '化药', applyType: '新药', regClass: '3类', company: 'X药业' }), false);
  assert.equal(inScope({ drugType: '化药', applyType: '新药', regClass: '1类', company: '不适用' }), false);
  // 归一自检
  assert.equal(normalize('江苏恒瑞医药股份有限公司'), normalize('江苏恒瑞医药有限公司'));
  assert.notEqual(normalize('江苏恒瑞医药股份有限公司'), normalize('江苏豪森药业集团有限公司'));

  const apply = process.argv.includes('--apply');
  let store;
  try { store = JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch (e) { console.error(`❌ 读不到 ${path.relative(WS, STORE)}: ${e.message}`); process.exit(1); }
  const before = Object.keys(store.rows || {}).length;
  const r = applyToStore(store);
  console.log(`归并前 ${before} 行 → 口径内 ${r.before} 行 | 越界剔除 ${r.dropped} | 重复归并 ${r.merged}`);
  if (r.mergedPairs.length) {
    console.log('归并样例:', r.mergedPairs.map(([a, b]) => `${a} + ${b}`).join(' ; '));
  }
  if (!apply) { console.log('(dry-run，加 --apply 落盘)'); process.exit(0); }
  store.scope = { drug_type: IN_SCOPE_TYPE, apply_type: [...APPLY], reg_class: '1|2.x', applied_at: new Date().toISOString() };
  fs.writeFileSync(STORE, JSON.stringify(store, null, 1));
  console.log(`✅ 已写入 ${path.relative(WS, STORE)}`);
}