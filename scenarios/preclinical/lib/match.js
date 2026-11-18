'use strict';
/**
 * 交叉标记：这条交易的公司/资产是否已在「临床阶段管线」（CDE 受理账本）里
 * 命中 → 销售知道这是已有上下文的资产（老客户/在跟的品种）；未命中 → 新冒出来的
 */
const fs = require('fs');
const path = require('path');
const scope = require(path.join(__dirname, '..', '..', 'pipeline', 'scope.js'));
const aliases = require('./aliases');

const WS = path.resolve(__dirname, '..', '..', '..');
const FILE = path.join(WS, 'output', 'history', 'pipeline-cde.json');

// 大客户短名（恒瑞/盛迪/豪森…）走销售指定的集团别名表，避免 2 字子串误配
let GROUPS = null;
function groupOf(name) {
  if (!GROUPS) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(WS, 'config', 'pipeline-bigpharma.json'), 'utf8'));
      GROUPS = Object.entries(cfg.groups || {}).map(([g, v]) => ({ g, aliases: [g, ...(v.aliases || [])] }));
    } catch { GROUPS = []; }
  }
  return GROUPS.find(x => x.aliases.some(a => name.includes(a)))?.g || '';
}

let INDEX = null;
function load() {
  if (INDEX) return INDEX;
  const rows = Object.values((JSON.parse(fs.readFileSync(FILE, 'utf8')).rows) || {});
  INDEX = new Set();
  for (const r of rows) INDEX.add(`${scope.companyKey(r.company)}|${scope.normalize(r.drugName)}`);
  return INDEX;
}

const codesOf = (s) => (String(s || '').toUpperCase().match(/[A-Z]{2,6}-?\d{2,6}[A-Z0-9]{0,4}/g) || []);

/** 返回 {hit:'是'|'否', how:'公司+资产'|'公司'|''} */
function match(ev) {
  const idx = load();
  const ck = scope.companyKey(ev.company_raw || '');
  if (ck.length < 2) return { hit: '否', how: '' };
  // 新闻写简称（恒瑞/信达），账本是全称 → 公司维度允许「互相包含」；短名（<3 字）要求完全相等
  const g = groupOf(ev.company_raw || '');
  const sameCo = (keyCo) => keyCo === ck
    || (ck.length >= 3 && keyCo.includes(ck))
    || (keyCo.length >= 4 && ck.includes(keyCo))
    || (g && groupOf(keyCo) === g);        // 「恒瑞」「盛迪」都归到恒瑞集团

  // 资产级：代号（含别名组）或名称互相包含
  for (const code of codesOf(ev.asset_raw)) {
    for (const key of idx) {
      const asset = key.split('|')[1] || '';
      if ([...codesOf(asset)].some(c => aliases.same(c, code))) return { hit: '是', how: '公司+资产' };
    }
  }
  const nm = scope.normalize(ev.asset_raw || '');
  if (nm.length >= 4) {
    for (const key of idx) {
      if (!sameCo(key.split('|')[0] || '')) continue;
      const asset = key.split('|')[1] || '';
      if (asset.includes(nm) || nm.includes(asset)) return { hit: '是', how: '公司+资产' };
    }
  }
  for (const key of idx) if (sameCo(key.split('|')[0] || '')) return { hit: '是', how: '公司' };
  return { hit: '否', how: '' };
}

module.exports = { match, load };
