'use strict';
/** 事件账本：events-<年>.json（唯一事实源；企微表只是它的投影） */

const fs = require('fs');
const path = require('path');

const WS = path.resolve(__dirname, '..', '..', '..');
const DIR = path.join(WS, 'output', 'history', 'preclinical');

const fileOf = (y) => path.join(DIR, `events-${y}.json`);
const load = (y) => { try { return JSON.parse(fs.readFileSync(fileOf(y), 'utf8')); } catch { return { events: {} }; } };
const save = (y, db) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(fileOf(y), JSON.stringify(db, null, 1)); };

const dayNum = (d) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 864e5);
// 资产代号集合：OLN324 / IBI324 / HSK47388 / RC298（不同稿子常给不同代号，如「IBI324（OLN324）」）
const codesOf = (s) => new Set((String(s || '').toUpperCase().match(/[A-Z]{2,6}-?\d{2,6}[A-Z0-9]{0,4}/g) || []));
const { same: sameAsset } = require('./aliases');
const shareCode = (a, b) => { const x = codesOf(a), y = codesOf(b); return [...x].some(c => [...y].some(d => sameAsset(c, d))); };
const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();

/** 同公司（或同资产）+ 同类型 + ±3 天 → 视为同一笔（转载/次日跟进稿自然折叠） */
function findSame(events, ev, days = 3) {
  const d0 = dayNum(ev.date);
  return Object.entries(events).find(([, x]) => {
    if (x.type !== ev.type) return false;
    if (Math.abs(dayNum(x.date) - d0) > days) return false;
    if (ev.asset_raw && x.asset_raw) return norm(x.asset_raw) === norm(ev.asset_raw) || shareCode(x.asset_raw, ev.asset_raw);
    return norm(x.company_raw) === norm(ev.company_raw);
  });
}

function upsert(db, ev) {
  const hit = findSame(db.events, ev);
  if (!hit) {
    const key = `EVT|${ev.company_raw}|${ev.asset_raw || '-'}|${ev.type}|${ev.date}`;
    db.events[key] = { ...ev, key, added_at: new Date().toISOString() };
    return { action: 'added', key };
  }
  const [key, old] = hit;
  for (const f of ['asset_raw', 'phase_raw', 'amount_upfront_raw', 'amount_total_raw', 'territory_raw']) {
    if (!old[f] && ev[f]) old[f] = ev[f];
  }
  old.sources = [...(old.sources || []), ...(ev.sources || [])];
  old.updated_at = new Date().toISOString();
  return { action: 'merged', key };
}

module.exports = { DIR, fileOf, load, save, upsert, findSame, dayNum, codesOf, shareCode };