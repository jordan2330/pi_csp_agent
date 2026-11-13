#!/usr/bin/env node
/**
 * 管线场景 —— 交付层 CLI（把打分后的公司×资产同步到第二张表）
 *
 * 用法：
 *   node scenarios/pipeline/sync.js --init          # 首次建表（幂等）+ 同步
 *   node scenarios/pipeline/sync.js --dry-run       # 只看会写多少行，不碰表
 *   node scenarios/pipeline/sync.js                 # 同步 A/B 档
 *   node scenarios/pipeline/sync.js --tiers A       # 只同步 A 档
 *
 * 目标表：WECOM_TABLE=pipeline + WECOM_ENV（dev 机器在 .env 里设了 dev）
 */

const fs = require('fs');
const path = require('path');
const WS = path.resolve(__dirname, '..', '..');
const scoring = require('./scoring');
const sheet = require('./sheet');

process.env.WECOM_TABLE = process.env.WECOM_TABLE || 'pipeline';   // 本 CLI 恒指向管线表

const FILE = path.join(WS, 'output', 'history', 'pipeline-cde.json');
const TIERS = (() => {
  const i = process.argv.indexOf('--tiers');
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1].toUpperCase().split(',') : ['A', 'B'];
})();
const DRY = process.argv.includes('--dry-run');
const DO_INIT = process.argv.includes('--init');
const DO_DEDUPE = process.argv.includes('--dedupe');

// 同资产异写：历史遗留的「规范化键」与「原始键」并存（HRS-6093 曾出现两行）。
// 以 原始公司名|原始药名 为准合并，保证商机键唯一（否则表里会长出重复行）。
function dedupe(rows) {
  const out = {};
  for (const r of Object.values(rows)) {
    const k = `${r.company}|${r.drugName}`;
    const o = out[k];
    if (!o) { out[k] = { ...r }; continue; }
    const late = (o.last_seen || '') >= (r.last_seen || '') ? o : r;
    const early = late === o ? r : o;
    out[k] = {
      ...early, ...late,
      first_seen: [o.first_seen, r.first_seen].filter(Boolean).sort()[0],
      reg_nos: [...new Set([...(o.reg_nos || []), ...(r.reg_nos || []), o.regNo, r.regNo].filter(Boolean))],
      phase: late.phase || early.phase || '', phase_rank: late.phase_rank || early.phase_rank || 0,
      phase_src: late.phase_src || early.phase_src || '', nct: late.nct || early.nct || '',
      d7: late.d7 || early.d7 || null
    };
  }
  return out;
}
const log = (...a) => console.log(...a);

(async () => {
  let store;
  try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {
    console.error(`❌ 读不到 ${path.relative(WS, FILE)}（先跑 sources-cde.js）: ${e.message}`); process.exit(1);
  }
  const rowsById = dedupe(store.rows || {});
  const mergedN = Object.keys(store.rows || {}).length - Object.keys(rowsById).length;
  if (mergedN > 0) {
    log(`账本同资产异写合并 ${mergedN} 条${DO_DEDUPE ? '（--dedupe：已落盘）' : '（仅内存，--dedupe 可落盘修复）'}`);
    if (DO_DEDUPE) { store.rows = rowsById; fs.writeFileSync(FILE, JSON.stringify(store, null, 1)); }
  }
  const all = Object.values(rowsById);
  const scored = all.map(r => {
    const s = scoring.score({
      drugName: r.drugName, company: r.company, regClass: r.regClass, phase: r.phase || '',
      regNo: r.regNo, d7: r.d7
    }, { mode: 'full' });
    return { ...r, ...s, key: `PIPE|${r.company}|${r.drugName}` };
  });
  // 窗口：最近受理日超 N 个月不进表（表内如有反馈则由 sheet.sync 保留，销售跟过的线索不消失）
  const WINDOW_MONTHS = Number(process.env.PIPE_WINDOW_MONTHS || 18);
  const cutoff = new Date(Date.now() - WINDOW_MONTHS * 30.4 * 864e5).toISOString().slice(0, 10);
  const lastAt = (r) => String(r.last_seen || r.date || '');
  const within = scored.filter(r => !lastAt(r) || lastAt(r) >= cutoff);
  const out = within.filter(r => !r.excluded && TIERS.includes(r.tier));
  log(`口径内 ${all.length} 行 → 窗口内 ${within.length} 行（>${WINDOW_MONTHS} 个月 ${scored.length - within.length} 行）→ 同步档位 ${TIERS.join('/')} 共 ${out.length} 行`);

  if (DO_INIT) {
    const cfg = await sheet.initTable();
    log(`目标表: ${cfg.url}`);
  }
  const r = await sheet.sync(out, { dryRun: DRY });
  log(JSON.stringify(r, null, 1));
})().catch(e => { console.error('❌', e.message); process.exit(1); });