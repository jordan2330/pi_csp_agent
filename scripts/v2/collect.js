#!/usr/bin/env node
/**
 * v2 采集 pipeline — 薄编排（M1）
 *
 *   FDA(缓存JSON→fda_apis) → CT.gov REST → CDT 浏览器
 *   每次运行全量拉 CT.gov（API 快），CDT 走 regNo 游标增量
 *
 * 用法:
 *   node scripts/v2/collect.js [--source fda|ctgov|cdt] [--apis A,B,C] [--db ...]
 *   --source 只跑一个源（调试/补数据）; --apis 限制搜索词清单（调试）
 *   full 模式（config/search-config.json）: CDT 游标全部置空重抓，完成后自动改回 incremental
 *
 * 新鲜度（验收 #13）: meta 表 ctgov_as_of / cdt_as_of 只在整源成功时更新;
 *   CDT 连不上浏览器 → 抛错不推 as_of → 周报标注"CDT 数据截至 <旧 as_of>"
 */
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const { openDB } = require('./db');
const { writeTrials, getCursor } = require('./store');
const { ingestFDA } = require('./sources/fda');
const { collectAPI: ctgovCollect } = require('./sources/ctgov');
const { runCDT } = require('./sources/cdt');

const ARGS = (() => {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, v] = a.includes('=') ? a.slice(2).split('=') : [a.slice(2), true];
    if (v === true && argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
    else out[k] = v;
  }
  return out;
})();
const DB_PATH = ARGS.db || path.join(ROOT, 'config', 'csp.db');
const SCENARIO = ARGS.scenario || 'nitrosamine';

const ts = () => new Date().toISOString().slice(11, 19);
const log = m => console.error(`[${ts()}] ${m}`);
const today = () => new Date().toISOString().slice(0, 10);
const cutoff = new Date(Date.now() - 2 * 365 * 864e5).toISOString().slice(0, 10);

async function main() {
  const scenarioDir = path.join(ROOT, 'scenarios', SCENARIO);
  const scenarioConfig = JSON.parse(fs.readFileSync(path.join(scenarioDir, 'scenario.json'), 'utf8'));
  const db = openDB(DB_PATH);
  const cacheFile = path.join(ROOT, scenarioConfig.cache_file);
  const searchMode = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'search-config.json'), 'utf8')).search_mode; }
    catch { return 'incremental'; }
  })();

  // ═══ FDA 阶段（--source 指定其他源时跳过） ═══
  const skipFDA = ARGS.source && ARGS.source !== 'fda';
  if (skipFDA) {
    log('═══ FDA 跳过（--source=' + ARGS.source + '）═══');
  } else {
    const fda = (() => {
      if (!fs.existsSync(cacheFile)) {
        const n = db.prepare('SELECT COUNT(*) c FROM fda_apis').get().c;
        if (n === 0) throw new Error(`FDA 数据缺失: ${cacheFile} 不存在且 fda_apis 表空——先执行 FDA 页抓取（Phase 1）`);
        log(`FDA: 复用 fda_apis 表中 ${n} 个 API（缓存文件缺失，标 stale）`);
        return null;
      }
      return ingestFDA(db, cacheFile, { log });
    })();
    void fda;
  }

  const wantedNeedles = ARGS.apis ? String(ARGS.apis).split(',').map(s => s.trim()) : null;
  // 暂不从 fda JSON 迁移游标——v1 的 last_cdt_regno 命脉是 fda_nitrosamines.json，v2 用 meta
  const allApis = db.prepare('SELECT en_name, cn_name FROM fda_apis ORDER BY en_name').all();
  const apis = wantedNeedles ? allApis.filter(a => wantedNeedles.includes(a.en_name)) : allApis;
  if (apis.length === 0) throw new Error(`API 清单为空${wantedNeedles ? `（--apis 指定了不存在的名字: ${ARGS.apis}）` : ''}`);
  log(`API 列表: ${apis.length} 个 (${SCENARIO}) | 模式: ${searchMode} | 截止线: ${cutoff}`);

  if (ARGS.source && ARGS.source !== 'ctgov') {
    log('═══ CT.gov 跳过（--source=' + ARGS.source + '）═══');
  } else {
    // ── CT.gov 阶段 ──
  log('═══ CT.gov ═══');
  let ctgovDone = 0, ctgovInserted = 0, ctgovUpdated = 0, ctgovErrors = 0;
  for (const { en_name } of apis) {
    try {
      const trials = await ctgovCollect(en_name, { cutoff, log: () => {} });
      const r = writeTrials(db, trials);
      ctgovInserted += r.inserted;
      ctgovUpdated += r.updated;
      ctgovDone++;
      if (ctgovDone % 50 === 0) log(`  进度 ${ctgovDone}/${apis.length}, +${ctgovInserted} 新`);
    } catch (e) {
      ctgovErrors++;
      if (ctgovErrors <= 5) log(`  ✗ ${en_name}: ${e.message.substring(0, 90)}`);
    }
    await new Promise(r => setTimeout(r, 800));
  }
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
  .run('ctgov_as_of', today());
  log(`CT.gov 完成: ${ctgovDone}/${apis.length}, +${ctgovInserted}, ${ctgovUpdated} 更新, ${ctgovErrors} 错误`);
  }

  // ── CDT 阶段 ──
  log('═══ CDT ═══');
  let cdtResult = null;
  if (ARGS.source && ARGS.source !== 'cdt') {
    log('═══ CDT 跳过（--source=' + ARGS.source + '）═══');
  } else try {
    const full = searchMode === 'full';
    const minYear = parseInt(cutoff.slice(0, 4));
    const cdtApis = apis
      .filter(a => a.cn_name)
      .map(a => ({ db, enName: a.en_name, cnName: a.cn_name, cursor: full ? '' : (getCursor(db, `cdt_cursor:${a.en_name}`) || '') }));
    const withCursor = cdtApis.filter(a => a.cursor).length;
    log(`CDT APIs: ${cdtApis.length} | 有游标: ${withCursor} | 首次: ${cdtApis.length - withCursor}`);
    cdtResult = await runCDT(db, cdtApis, { workerCount: 2, minYear, log });
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('cdt_as_of', today());
  } catch (e) {
    // 验收 #13: 不静默 —— 记录失败并保留旧 as_of（数据新鲜度可被周报标注）
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('cdt_last_error', `${today()}: ${e.message.substring(0, 200)}`);
    log(`❌ CDT 失败（as_of 未推进）: ${e.message.substring(0, 120)}`);
  }

  const ctgov_as_of = db.prepare("SELECT value FROM meta WHERE key='ctgov_as_of'").get()?.value;
  const cdt_as_of = db.prepare("SELECT value FROM meta WHERE key='cdt_as_of'").get()?.value;
  const totals = db.prepare('SELECT COUNT(*) c FROM trials').get().c;
  log(`═══ 完成 ═══ 库内 trials: ${totals} | CT.gov as_of: ${ctgov_as_of} | CDT as_of: ${cdt_as_of || 'NEVER'}`);

  // full 模式跑完自动回退 incremental（与 v1 语义一致）
  if (searchMode === 'full' && !ARGS.apis) {
    const cfg = path.join(ROOT, 'config', 'search-config.json');
    fs.writeFileSync(cfg, JSON.stringify({ search_mode: 'incremental' }));
    log('已自动改回 search_mode=incremental');
  }
}

main().catch(e => { console.error(`FATAL: ${e.message}`); process.exit(1); });