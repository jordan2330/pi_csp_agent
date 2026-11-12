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
const log = (...a) => console.log(...a);

(async () => {
  let store;
  try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {
    console.error(`❌ 读不到 ${path.relative(WS, FILE)}（先跑 sources-cde.js）: ${e.message}`); process.exit(1);
  }
  const all = Object.values(store.rows || {});
  const scored = all.map(r => {
    const s = scoring.score({
      drugName: r.drugName, company: r.company, regClass: r.regClass, phase: r.phase || '',
      regNo: r.regNo, applyType: r.applyType, lastSeen: r.last_seen
    }, { mode: 'full' });
    return { ...r, ...s, key: `PIPE|${r.company}|${r.drugName}` };
  });
  const out = scored.filter(r => !r.excluded && TIERS.includes(r.tier));
  log(`口径内 ${all.length} 行 → 同步档位 ${TIERS.join('/')} 共 ${out.length} 行`);

  if (DO_INIT) {
    const cfg = await sheet.initTable();
    log(`目标表: ${cfg.url}`);
  }
  const r = await sheet.sync(out, { dryRun: DRY });
  log(JSON.stringify(r, null, 1));
})().catch(e => { console.error('❌', e.message); process.exit(1); });