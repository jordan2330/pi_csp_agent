/**
 * 商机沉淀账本（历史累积，独立于数据源缓存）
 *
 * 为什么需要它：数据源缓存会被重置（重扫 CDT/CDE 会清记录），而"首次发现时间"
 * 这类历史信息不能跟着丢；同时 Excel 需要一个稳定的"沉淀"底座。
 *
 * 两个账本（derived data，gitignore 内）：
 *   output/history/ledger.json  每条商机：{ first_seen, last_seen, api, drugName, sponsor, regDate, source, regNo }
 *   output/history/runs.json    每次运行：{ run, date, new, total, sources, archived, enrich }
 *
 * 语义（两个概念不要混）：
 *   ★ 本次新增  = 相对"上一次运行"的新增（pipeline 现有 isNew 逻辑，含同日二次运行处理）
 *   首次发现    = 历史上第一次见到（本账本，稳定不变，重扫也不重置）
 *
 * 导出：
 *   apply(trials, meta)  → 给每条 trials 挂 first_seen；返回 { archived:[...], newCount, total }
 *   loadLedger / loadRuns / appendRun / updateStats
 *   回填与统计 CLI：node scripts/lib/history.js [--backfill] [--stats]
 */

const fs = require('fs');
const path = require('path');

const WS = path.join(__dirname, '..', '..');
const DIR = path.join(WS, 'output', 'history');
const LEDGER = path.join(DIR, 'ledger.json');
const RUNS = path.join(DIR, 'runs.json');

function ensureDir() { try { fs.mkdirSync(DIR, { recursive: true }); } catch (_) {} }
function readJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJSON(file, obj) {
  ensureDir();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);          // 原子写：爬取中途被杀不会留下半个账本
}
function loadLedger() { return readJSON(LEDGER, { entries: {} }); }
function loadRuns() { return readJSON(RUNS, { runs: [] }); }
function saveLedger(l) { writeJSON(LEDGER, l); }
function saveRuns(r) { writeJSON(RUNS, r); }

// 商机唯一键：同一条试验可能命中多个 API，键用来源+登记号（与 Excel 去重口径一致）
function key(t) { return `${t.source || '?'}|${t.regNo || '?'}`; }

/**
 * 沉淀：把当前 trials 写入账本
 * @param {Array} trials  当前快照全部商机（会被就地补上 first_seen / last_seen）
 * @param {Object} meta   { date, run }  date=YYYY-MM-DD, run=显示用时间戳
 * @returns {{archived:Array, newCount:number, total:number}}
 */
function apply(trials, meta = {}) {
  const date = meta.date || new Date().toISOString().slice(0, 10);
  const ledger = loadLedger();
  const entries = ledger.entries || (ledger.entries = {});
  const seen = new Set();
  let firstTime = 0;

  for (const t of trials) {
    const k = key(t);
    seen.add(k);
    const e = entries[k];
    if (!e) {
      entries[k] = {
        first_seen: date, last_seen: date,
        api: t.apiName || t.api || '', drugName: t.drugName || '', sponsor: t.sponsor || '',
        regDate: t.regDate || '', source: t.source || '', regNo: t.regNo || ''
      };
      firstTime++;
    } else {
      e.last_seen = date;
      if (!e.api) e.api = t.apiName || t.api || '';
    }
    t.first_seen = entries[k].first_seen;
    t.last_seen = date;
  }

  // 账本里有、本次快照没有的 → 归档行（缓存被重置也能保留历史）
  const archived = [];
  for (const [k, e] of Object.entries(entries)) {
    if (seen.has(k)) continue;
    archived.push({
      apiName: e.api, drugName: e.drugName, sponsor: e.sponsor, regDate: e.regDate,
      source: e.source, regNo: e.regNo, first_seen: e.first_seen, last_seen: e.last_seen,
      archived: true, isNew: false
    });
  }

  saveLedger(ledger);
  return { archived, newCount: firstTime, total: Object.keys(entries).length };
}

/** 追加一条运行批次记录 */
function appendRun(rec) {
  const r = loadRuns();
  r.runs = r.runs || [];
  const idx = r.runs.findIndex(x => x.run === rec.run);
  if (idx >= 0) r.runs[idx] = rec; else r.runs.push(rec);
  r.runs = r.runs.slice(-200);                  // 只留最近 200 批次
  saveRuns(r);
  return r.runs.length;
}

/** 从历史快照回填 first_seen（一次性迁移用） */
function backfill(runsDir = path.join(WS, 'output', 'runs')) {
  const files = fs.readdirSync(runsDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const ledger = loadLedger();
  const entries = ledger.entries || (ledger.entries = {});
  let added = 0;
  for (const f of files) {
    const date = f.replace('.json', '');
    const snap = readJSON(path.join(runsDir, f), null);
    if (!snap || !snap.trials_data) continue;
    for (const [apiName, trials] of Object.entries(snap.trials_data.results || {})) {
      for (const t of trials || []) {
        const k = key(t);
        if (!entries[k]) {
          entries[k] = { first_seen: date, last_seen: date, api: apiName, drugName: t.drugName || '', sponsor: t.sponsor || '', regDate: t.regDate || '', source: t.source || '', regNo: t.regNo || '' };
          added++;
        } else if (date < entries[k].first_seen) {
          entries[k].first_seen = date;
        }
      }
    }
  }
  saveLedger(ledger);
  return { added, files: files.length, total: Object.keys(entries).length };
}

function stats() {
  const l = loadLedger();
  const r = loadRuns();
  const byBatch = {};
  Object.values(l.entries || {}).forEach(e => { byBatch[e.first_seen] = (byBatch[e.first_seen] || 0) + 1; });
  const bySource = {};
  Object.values(l.entries || {}).forEach(e => { bySource[e.source] = (bySource[e.source] || 0) + 1; });
  return { total: Object.keys(l.entries || {}).length, byBatch, bySource, runs: (r.runs || []).length, lastRun: (r.runs || []).slice(-1)[0] };
}

module.exports = { key, apply, loadLedger, loadRuns, appendRun, backfill, stats };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--backfill')) {
    const r = backfill();
    console.log(`回填完成: 新增 ${r.added} 条记录（来自 ${r.files} 份快照）| 账本总计 ${r.total} 条`);
  }
  const s = stats();
  console.log(`账本: ${s.total} 条商机 | 来源 ${JSON.stringify(s.bySource)}`);
  console.log(`按首次发现批次: ${JSON.stringify(s.byBatch)}`);
  console.log(`运行批次: ${s.runs} 次${s.lastRun ? `（最近 ${s.lastRun.run} 新增 ${s.lastRun.new}）` : ''}`);
}