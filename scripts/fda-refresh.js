#!/usr/bin/env node
/**
 * FDA 元信息刷新（人工按需跑，FDA 页面一年只更新几次）
 *
 * 用法：
 *   node scripts/fda-refresh.js                # 刷新并落盘（有变化才写）
 *   node scripts/fda-refresh.js --dry-run      # 只看差异，不写
 *   node scripts/fda-refresh.js nitrosamine    # 指定场景（默认 nitrosamine）
 *
 * 做什么：抓 FDA「CDER 亚硝胺可接受摄入限值」页，只更新
 *   api 列表 / potency_category / ai_limit / nitrosamines / <cache_version_field> / last_updated
 * 不动什么（关键：增量采集依赖它们）：
 *   每个 API 的 results（CT.gov 缓存）、last_cdt_regno（CDT 增量游标）、fda_detected_at（首次发现）
 *
 * 安全阀（任一命中 → 不写文件，退出码 1）：
 *   抓取失败 / 解析 0 行 / API 数比现有少 20% 以上 / 页头版本取不到 / pipeline 正在运行
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WS = path.resolve(__dirname, '..');
const FDA_URL = 'https://www.fda.gov/regulatory-information/search-fda-guidance-documents/cder-nitrosamine-impurity-acceptable-intake-limits';
const TODAY = new Date().toISOString().slice(0, 10);
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const FORCE = args.includes('--force');
const scenarioName = args.find(a => !a.startsWith('--')) || 'nitrosamine';

const log = (...a) => console.log(...a);
const die = (msg) => { console.error(`❌ ${msg}\n   已保留原缓存，未写入任何内容`); process.exit(1); };

// ── 实体解码 + 去 FDA 脚注 ** ──
const clean = (s) => String(s)
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ').trim().replace(/\s*\*+$/, '').trim();

(async () => {
  // ── 场景配置（缓存路径与版本字段由 scenario.json 决定）──
  const scenarioDir = path.join(WS, 'scenarios', scenarioName);
  const scFile = path.join(scenarioDir, 'scenario.json');
  if (!fs.existsSync(scFile)) die(`场景不存在: scenarios/${scenarioName}/scenario.json`);
  let sc;
  try { sc = JSON.parse(fs.readFileSync(scFile, 'utf8')); } catch (e) { die(`scenario.json 解析失败: ${e.message}`); }
  const CACHE = path.join(WS, sc.cache_file);
  const VER_FIELD = sc.cache_version_field || 'fda_page_version';
  // 缓存损坏时直接退出 —— 当成空文件重建会把全部 results 与 CDT 游标抹除
  let old = { apis: {} };
  if (fs.existsSync(CACHE)) {
    try { old = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch (e) { die(`现有缓存解析失败，拒绝覆写: ${sc.cache_file} (${e.message})`); }
  }
  const oldCount = Object.keys(old.apis || {}).length;

  // ── 安全阀：pipeline 正在跑时，它的内存副本会把本次刷新覆盖掉 ──
  if (!FORCE) {
    let running = '';
    try { running = execSync('pgrep -af "[r]un-pipeline\\.js" || true', { encoding: 'utf8' }).trim(); } catch { /* pgrep 不存在则跳过 */ }   // [r] 防匹配到本条 pgrep 自身
    if (running) die(`检测到 pipeline 正在运行，刷新结果会被它回写覆盖：\n   ${running}\n   等它跑完再刷，或加 --force 强行刷新`);
  }

  // ── 抓页面 ──
  log(`抓取 FDA 页面…`);
  let html;
  try {
    const res = await fetch(FDA_URL, { headers: { 'user-agent': 'Mozilla/5.0 (pi-csp-agent fda-refresh)' }, signal: AbortSignal.timeout(60000) });
    if (!res.ok) die(`FDA 页面返回 ${res.status}`);
    html = await res.text();
  } catch (e) {
    die(`FDA 页面抓取失败: ${e.message}`);
  }

  // ── 解析主表（4 列：亚硝胺 / API / Cat / AI limit）──
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/g)].map(m => m[0]);
  const tbl = tables.find(t => /Nitrosamine Name/i.test(t));
  if (!tbl) die('页面上未找到「Nitrosamine Name」主表（页面可能改版）');
  const rows = [...tbl.matchAll(/<tr[\s\S]*?<\/tr>/g)].map(m => m[0]).slice(1);
  const parsed = new Map();   // API → { nitrosamines:Set, cat, limit, cats:Set }
  let rowCount = 0;
  for (const r of rows) {
    const cells = [...r.matchAll(/<t[dh][\s\S]*?<\/t[dh]>/g)].map(c => clean(c[0]));
    if (cells.length < 4) continue;
    const [nitro, srcRaw, catRaw, limitRaw] = cells;
    const cat = parseInt(catRaw, 10);
    if (!nitro || !srcRaw || !(cat >= 1 && cat <= 5)) continue;
    rowCount++;
    for (const src of srcRaw.split(/[;；]/).map(s => s.trim()).filter(Boolean)) {
      if (/^multiple$/i.test(src)) continue;   // FDA 用 "Multiple" 表示不特指某个 API
      const cur = parsed.get(src) || { nitrosamines: new Set(), cat, limit: limitRaw, cats: new Set() };
      cur.nitrosamines.add(nitro); cur.cats.add(cat);
      if (cat < cur.cat) { cur.cat = cat; cur.limit = limitRaw; }   // 一个 API 多条记录 → 取最严（Cat 数最小）
      parsed.set(src, cur);
    }
  }

  // ── 安全阀：解析结果异常 ──
  if (!rowCount || !parsed.size) die(`解析到 ${rowCount} 行 / ${parsed.size} 个 API —— 页面结构可能变了`);
  if (oldCount && parsed.size < oldCount * 0.8) die(`解析到的 API 数 ${parsed.size} 比现有 ${oldCount} 少 20% 以上（疑似页面改版或抓取不全）`);
  const mV = html.match(/Content current as of:?[\s\S]{0,300}?(\d{2})\/(\d{2})\/(\d{4})/);
  if (!mV) die('页头「Content current as of」日期取不到');
  const pageVersion = `${mV[3]}-${mV[1]}-${mV[2]}`;

  // ── 合并（保留 results / 游标 / 首次发现）──
  let trans = {};
  try {
    const t = JSON.parse(fs.readFileSync(path.join(WS, 'config', 'api_translations.json'), 'utf8'));
    trans = t.translations || t;
  } catch { /* 无翻译表不影响刷新 */ }
  const lowerIndex = new Map(Object.keys(old.apis || {}).map(k => [k.toLowerCase(), k]));
  const apis = {};
  const diff = { added: [], removed: [], cat: [], limit: [], nitro: [], noCn: [] };
  for (const [api, p] of parsed) {
    const oldKey = lowerIndex.get(api.toLowerCase());
    const prev = oldKey ? old.apis[oldKey] : null;
    const key = oldKey || api;                      // FDA 改了大小写 → 沿用旧键，避免同一 API 出现两条
    const nameCn = (prev && prev.name_cn) || trans[api] || trans[key] || '';
    if (!nameCn) diff.noCn.push(key);
    apis[key] = {
      name_cn: nameCn,
      ai_limit: p.limit,
      potency_category: p.cat,
      nitrosamines: [...p.nitrosamines],
      fda_detected_at: prev ? prev.fda_detected_at : TODAY,
      last_cdt_regno: prev ? (prev.last_cdt_regno || '') : '',
      lead_count: prev ? (prev.lead_count || 0) : 0,
      results: prev ? (prev.results || []) : []
    };
    if (!prev) diff.added.push(key);
    else {
      if (prev.potency_category !== p.cat) diff.cat.push(`${key}: Cat${prev.potency_category} → Cat${p.cat}`);
      if (prev.ai_limit !== p.limit) diff.limit.push(`${key}: ${prev.ai_limit} → ${p.limit}`);
      const a = new Set(prev.nitrosamines || []), b = [...p.nitrosamines];
      const up = b.filter(x => !a.has(x)).length, down = [...a].filter(x => !b.includes(x)).length;
      if (up || down) diff.nitro.push(`${key}: +${up} / -${down}`);
    }
  }
  for (const [k, v] of Object.entries(old.apis || {})) {
    if (![...parsed.keys()].some(a => a.toLowerCase() === k.toLowerCase())) { apis[k] = v; diff.removed.push(k); }   // 页面已移除：保留历史
  }

  // ── 报告 ──
  const total = Object.keys(apis).length;
  const cnt = (f) => Object.values(apis).filter(f).length;
  log(`页面版本: ${old[VER_FIELD] || '(无)'} → ${pageVersion} | 数据行 ${rowCount} | API ${oldCount} → ${total}`);
  log(`新增 ${diff.added.length}: ${diff.added.join(', ') || '(无)'}`);
  log(`页面已移除 ${diff.removed.length}: ${diff.removed.join(', ') || '(无)'}（保留历史结果，不删）`);
  log(`Cat 变化 ${diff.cat.length}: ${diff.cat.slice(0, 20).join(' | ') || '(无)'}`);
  log(`AI limit 变化 ${diff.limit.length}: ${diff.limit.slice(0, 10).join(' | ') || '(无)'}`);
  log(`亚硝胺名单变化 ${diff.nitro.length}: ${diff.nitro.slice(0, 10).join(' | ') || '(无)'}`);
  log(`保留: ${cnt(a => (a.results || []).length)} 个 API 的 results / ${cnt(a => a.last_cdt_regno)} 个 CDT 游标`);
  if (diff.noCn.length) log(`⚠️ 新增且缺中文名（补 config/api_translations.json 后这些 API 才会被搜）: ${diff.noCn.join(', ')}`);

  const noChange = old[VER_FIELD] === pageVersion && !diff.added.length && !diff.removed.length &&
    !diff.cat.length && !diff.limit.length && !diff.nitro.length;
  if (noChange && oldCount === total && !DRY) { log('\n✅ 页面无变化，未写入（缓存保持原样）'); return; }
  if (DRY) { log('\n(dry-run，未写入；去掉 --dry-run 落盘)'); return; }

  // ── 落盘（先备份，再原子写）──
  const bkDir = path.join(WS, 'output', 'runs', 'fda-backups');
  fs.mkdirSync(bkDir, { recursive: true });
  const bk = path.join(bkDir, `${path.basename(CACHE, '.json')}-${Date.now()}.json`);
  if (fs.existsSync(CACHE)) fs.copyFileSync(CACHE, bk);
  fs.readdirSync(bkDir).sort().slice(0, -5).forEach(f => { try { fs.unlinkSync(path.join(bkDir, f)); } catch { /* 清理失败无妨 */ } });   // 只留最近 5 份
  const next = { ...old, last_updated: TODAY, [VER_FIELD]: pageVersion, apis };
  const tmp = CACHE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, CACHE);
  log(`\n✅ 已写入 ${sc.cache_file}（备份: ${path.relative(WS, bk)}，保留最近 5 份）`);
})().catch(e => die(e.stack || e.message));