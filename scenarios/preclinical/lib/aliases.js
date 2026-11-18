'use strict';
/**
 * 资产代号别名（授权后改名：IBI324 → OLN324）
 *
 * 为什么需要：去重键用「代号」，同一款药前后两个代号会被判成两笔交易 → 子表重复行。
 * 学习来源：公告/稿件里常见的「IBI324（OLN324）」「旧代号/新代号」写法，自动配对。
 * 同一组内的代号视为同一资产；人工可在 config/preclinical-asset-aliases.json 里改。
 */

const fs = require('fs');
const path = require('path');

const WS = path.resolve(__dirname, '..', '..', '..');
const FILE = path.join(WS, 'config', 'preclinical-asset-aliases.json');

let CACHE = null;                                   // findSame 里会被调用 N×M 次，缓存一次
const load = () => {
  if (CACHE) return CACHE;
  try { CACHE = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { CACHE = { groups: [] }; }
  return CACHE;
};
const save = (db) => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(db, null, 1)); CACHE = db; };

// 靶点名（IL-17 / IL-23 / GLP-1）不是资产代号：至少一侧要有 ≥3 位数字才算
const isAsset = (c) => /\d{3,}/.test(c);
const norm = (c) => String(c || '').toUpperCase().replace(/[‐－]/g, '-');

/** 从一段文本里学配对：A（B）、A (B)、A/B、A（曾用名 B） */
function learn(text) {
  const db = load();
  const pairs = [];
  const paren = /([A-Z]{2,6}-?\d{2,6}[A-Z0-9]{0,4})\s*[（(]\s*(?:曾用名|原名|现名|新代号|原代号)?\s*([A-Z]{2,6}-?\d{2,6}[A-Z0-9]{0,4})/gi;
  const slash = /([A-Z]{2,6}-?\d{2,6}[A-Z0-9]{0,4})\s*[/、]\s*([A-Z]{2,6}-?\d{2,6}[A-Z0-9]{0,4})/g;
  for (const re of [paren, slash]) {
    let m;
    while ((m = re.exec(String(text || '')))) {
      const a = norm(m[1]), b = norm(m[2]);
      if (a === b || !isAsset(a) || !isAsset(b)) continue;
      pairs.push([a, b]);
    }
  }
  if (!pairs.length) return 0;
  let added = 0;
  for (const [a, b] of pairs) {
    const ga = db.groups.find(g => g.includes(a));
    const gb = db.groups.find(g => g.includes(b));
    if (ga && gb) {
      if (ga === gb) continue;
      const merged = [...new Set([...ga, ...gb])];
      db.groups = db.groups.filter(g => g !== gb);
      db.groups[db.groups.indexOf(ga)] = merged;
      added++;
    } else if (ga) { ga.push(b); added++; }
    else if (gb) { gb.push(a); added++; }
    else { db.groups.push([a, b]); added++; }
  }
  if (added) save(db);
  return added;
}

/** 代号 → 组代表（组内第一个，稳定） */
function canon(code) {
  const c = norm(code);
  const g = load().groups.find(x => x.includes(c));
  return g ? g[0] : c;
}

/** 两个代号是否同一资产（含别名组） */
function same(a, b) {
  const ca = canon(a), cb = canon(b);
  if (ca === cb) return true;
  const ga = load().groups.find(g => g.includes(ca));
  return !!ga && ga.includes(cb);
}

module.exports = { learn, canon, same, isAsset, FILE, load, save };