/**
 * CDE 官方受理品种信息 → 注册分类证据（Phase 2c 主数据源）
 *
 * 为什么用它：CDE「受理品种信息」是官方一手申报数据，直接给出
 *   受理号 / 药品名称 / 药品类型 / 申请类型 / 注册分类 / 企业名称 / 承办日期
 * 比"搜索二手信息猜分类"（博查）准确，且免费、无查询成本。
 *
 * 数据来源（政府信息公开页，与 CDT 同性质）：
 *   https://www.cde.org.cn/main/xxgk/listpage/9f9c74c73e0f8f56a8bfbc646055026d
 *
 * 证据条目结构与 nmpa-search.js 保持**完全一致**（core/rules_version/queried_at/facts/…），
 * 因此 report.js 的证据挂载与 classifyFacts 逻辑无需改动即可复用。
 *
 * 导出:
 *   enrichProducts(names, opts) → { queried, skippedBudget, failed }
 *   enrichProduct(page, name, opts) → entry
 *   collectTargets(apis)        → 待查品种名（API 中文名）
 *   loadCache() / saveCache() / isFresh()
 *   classifyFacts(entry)        → 见 nmpa-search（复用）
 *   connectBrowser() / closeBrowser()
 */

const fs = require('fs');
const path = require('path');

require('dns').setDefaultResultOrder('ipv4first');   // WSL 下避免 IPv6 卡死

const WS = path.join(__dirname, '..', '..');
const CACHE_FILE = path.join(WS, 'config', 'cde_class_cache.json');
const CONFIG_FILE = path.join(WS, 'config', 'cde-classify.json');
const CDE_URL = 'https://www.cde.org.cn/main/xxgk/listpage/9f9c74c73e0f8f56a8bfbc646055026d';
const RULES_VERSION = 1;   // 规则变更 → 旧证据自动失效

const DEFAULTS = {
  enabled: true,
  cache_ttl_days: 90,
  max_pages_per_product: 2,
  page_size: 50,
  delay_between_products_ms: [700, 1300],
  query_timeout_ms: 20000,
  max_products_per_run: 300,
  workers: 1
};

function loadConfig() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}
function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch { return { rules_version: RULES_VERSION, products: {} }; }
}
function saveCache(cache) {
  cache.rules_version = RULES_VERSION;
  cache.updated_at = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));
}
function isFresh(entry, ttlDays) {
  if (!entry || !entry.queried_at) return false;
  if (entry.rules_version !== RULES_VERSION) return false;
  return (Date.now() - new Date(entry.queried_at).getTime()) / 86400000 <= (ttlDays || DEFAULTS.cache_ttl_days);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 品种名归一（与 nmpa-search.coreName 同口径：去盐/去剂型，只留中文核心名）──
function coreName(productName) {
  let s = String(productName || '').trim();
  s = s.replace(/[（(][^）)]*[）)]/g, ' ');
  s = s.replace(/^(盐酸|硫酸|磷酸|枸橼酸|柠檬酸|马来酸|富马酸|酒石酸|氢溴酸|醋酸|乙酸|乳酸|甲磺酸|苯磺酸|琥珀酸|门冬氨酸|谷氨酸|双氯|硝酸|碳酸|氢氯|氯化钠|葡萄糖|复方|注射用|注射|吸入用|口服|外用|冻干|无菌)/, '');
  s = s.replace(/(片|胶囊|颗粒|散|丸|滴丸|糖浆|口服液|口服溶液|混悬液|注射液|注射剂|乳膏|凝胶|软膏|贴|气雾剂|喷雾剂|吸入剂|栓|滴眼液|滴鼻剂|膜|缓释片|控释片|缓释胶囊|肠溶片|肠溶胶囊|分散片|咀嚼片|口崩片|缓释|控释|肠溶)$/g, '');
  return s.trim();
}
// 企业名归一（去尾部重复的"；公司；公司"）
function baseCompany(s) {
  return String(s || '').split(/[;；]/)[0].trim().replace(/[（(].*?[）)]/g, '');
}
// 受理号前缀 → 申请类型补充判断（CYHS/CXHS=境内申报，JYHS/JXHS=进口，CYHB=补充申请…）
function normClass(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^5\.[12]$/.test(s)) return s;
  const m = s.match(/[1-4]/);
  return m ? m[0] : '';
}

/**
 * 从受理记录行推导分类事实（facts 键与 nmpa-search 兼容）
 * 注册分类口径（《化学药品注册分类及申报资料要求》2020）：
 *   1类=创新药  2类=改良型新药  3类/4类=境内仿制(3类仿境外未上市原研/4类仿境内已上市原研)
 *   5.1类=境外已上市增加境内适应症  5.2类=境外生产仿制药
 */
function deriveFacts(rows) {
  const genericClasses = new Set();
  const companies = {};            // 企业 → 分类集合（供"同企业"证据展示）
  const evidence = [];
  let iec = false, innovative = false, improved = false, classed = 0;

  for (const r of rows) {
    const cls = normClass(r.regClass);
    const co = baseCompany(r.company);
    if (cls) {
      classed++;
      if (cls === '1') innovative = true;
      else if (cls === '2') improved = true;
      else if (cls === '3' || cls === '4' || cls === '5.2') genericClasses.add(cls);
    }
    if (/一致性评价/.test(r.applyType || '')) iec = true;
    if (/仿制/.test(r.applyType || '') && !cls) genericClasses.add('4');   // 申请类型=仿制但分类空
    if (co) companies[co] = [...new Set([...(companies[co] || []), cls || (r.applyType || '').slice(0, 6)])];
    if (evidence.length < 40) evidence.push({ text: [r.drugName, r.regClass ? r.regClass + '类' : '', r.applyType, co, r.date].filter(Boolean).join(' · '), url: '' });
  }

  const order = ['4', '3', '5.2'];
  const dispClass = order.find(c => genericClasses.has(c)) || '';
  const facts = {
    genericClass34: dispClass,
    regClassDisp: dispClass,
    ...(iec ? { iec: true } : {}),
    ...(innovative ? { innovative: true } : {}),
    ...(improved ? { improved: true } : {}),
    totalRows: rows.length,
    classedRows: classed
  };
  // 摘要（Excel 证据来源列可读）
  const summary = [
    rows.length ? `CDE受理${rows.length}条` : '',
    dispClass ? `${dispClass}类仿制` : '',
    iec ? '一致性评价申报' : '',
    innovative ? '1类创新' : '',
    improved ? '2类改良' : ''
  ].filter(Boolean).join(' / ');
  return { facts, companies, evidence, summary, hasSignal: !!(dispClass || iec || innovative || improved) };
}

// ── 浏览器操作 ──
async function connectBrowser() {
  const lib = require(path.join(WS, 'skills', 'browser_executor', 'scripts', 'cdt-search-lib'));
  const browser = await lib.connectBrowser();
  const context = await lib.createWorkerContext(browser);
  return { browser, context, page: await context.newPage() };
}

async function openForm(page) {
  // 重试 3 次（ERR_ABORTED 常见于 SPA 重定向，页面其实已可用）
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(CDE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      lastErr = null; break;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }
  const formReady = await page.evaluate(() => !!document.querySelector("input[placeholder='请输入药品名称']")).catch(() => false);
  if (!formReady && lastErr) throw lastErr;
  // 就绪判定：查询按钮存在 + 初始列表已渲染（否则点查询会空转，返回默认列表）
  await page.waitForFunction(() => {
    const inp = document.querySelector("input[placeholder='请输入药品名称']");
    const btn = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === '查询');
    const t = document.querySelectorAll('table')[0];
    return !!(inp && btn && t && t.querySelectorAll('tr').length > 2);
  }, { timeout: 30000, polling: 400 }).catch(() => {});
  await sleep(3000);
  return page;
}

async function setPageSize(page, size) {
  return page.evaluate((n) => {
    const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => /条\/页/.test(o.text)));
    if (!sel) return 'no-select';
    sel.value = String(n);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  }, size);
}

const FIRST_ROW = `(() => { const t = document.querySelectorAll('table')[0]; const r = t && t.querySelectorAll('tr')[1]; return r ? r.innerText.slice(0, 120) : ''; })()`;

// 查询单个品种 → 返回受理记录行数组
async function queryProduct(page, name, cfg, defaultSig) {
  const core = coreName(name) || String(name || '').trim();
  const target = String(name || '').trim();
  let lastRows = [], failed = true;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const clicked = await page.evaluate((nm) => {
      const inp = [...document.querySelectorAll("input[placeholder='请输入药品名称']")].find(i => i.offsetParent !== null);
      if (!inp) return 'no-visible-input';
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inp, nm);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      const form = inp.closest('form');
      const btn = (form ? [...form.querySelectorAll('button')] : []).find(b => b.innerText.trim() === '查询')
        || [...document.querySelectorAll('button')].find(b => b.innerText.trim() === '查询');
      if (!btn) return 'no-btn';
      btn.click();
      return 'ok';
    }, target);
    if (clicked !== 'ok') throw new Error(`查询控件定位失败: ${clicked}`);

    const t0 = Date.now();
    let verdict = 'timeout';
    try {
      const handle = await page.waitForFunction(({ core, t0 }) => {
        const t = document.querySelectorAll('table')[0];
        if (!t) return false;
        const empty = /暂无内容|暂无数据/.test(t.innerText);
        const rows = [...t.querySelectorAll('tr')].slice(1).filter(r => r.innerText.trim().length > 5);
        const since = Date.now() - t0;
        if (core && rows.some(r => r.innerText.includes(core))) return 'hit';
        if (empty && since > 2500) return 'empty';
        if (rows.length && since > 2500) return 'nomatch';
        return false;
      }, { core, t0 }, { timeout: 15000, polling: 300 });
      verdict = await handle.jsonValue();
    } catch (_) { /* 超时 */ }
    await sleep(300);

    const parsed = await parseTableWithTotal(page);
    const currentSig = await page.evaluate(FIRST_ROW);
    lastRows = parsed.rows;

    // 关键校验：结果与"默认列表"（未筛选的最近受理）完全相同 → 查询没生效 → 重试
    const notApplied = !!(parsed.rows.length && defaultSig && currentSig === defaultSig);
    if (notApplied) { await sleep(1500 * attempt); continue; }

    if (verdict === 'hit') return { rows: parsed.rows, failed: false };
    if (verdict === 'empty') return { rows: [], failed: false };          // 可信空：CDE 确无该品种记录
    if (parsed.rows.length && parsed.total !== 0) return { rows: parsed.rows, failed: false };
    await sleep(1000 * attempt);                                          // 超时/无匹配 → 重试
  }
  return { rows: lastRows, failed };
}

async function parseTableWithTotal(page) {
  return page.evaluate(() => {
    const t = document.querySelectorAll('table')[0];
    if (!t) return { rows: [], total: null };
    const rows = [...t.querySelectorAll('tr')].slice(1).map(r => {
      const c = [...r.querySelectorAll('td')].map(x => x.innerText.trim().replace(/\s+/g, ' '));
      if (c.length < 6 || /暂无内容|暂无数据/.test(r.innerText)) return null;
      return { regNo: c[1] || '', drugName: c[2] || '', drugType: c[3] || '', applyType: c[4] || '', regClass: c[5] || '', company: c[6] || '', date: c[7] || '' };
    }).filter(Boolean).filter(r => r.drugName);
    // 总条数（自校验用）：结果区容器优先，退化到可见区域全文
    // 注意：空结果时 CDE 只显示"暂无内容"，不显示"共 N 条" → total=0 表示可信的空结果
    let el = t, total = null;
    for (let i = 0; i < 4 && el; i++) { el = el.parentElement; if (!el) break; const m = el.innerText.match(/共\s*([0-9]+)\s*条/); if (m) { total = Number(m[1]); break; } }
    const empty = /暂无内容|暂无数据/.test(t.innerText);
    if (total === null) {
      const m = document.body.innerText.match(/共\s*([0-9]+)\s*条/);
      if (m) total = Number(m[1]); else if (empty) total = 0;
    }
    return { rows, total, empty };
  });
}

async function parseTable(page) {
  const r = await parseTableWithTotal(page);
  return r.rows;
}

async function _parseTableLegacy(page) {
  return page.evaluate(() => {
    const t = document.querySelectorAll('table')[0];
    if (!t) return [];
    const rows = [...t.querySelectorAll('tr')].slice(1);
    return rows.map(r => {
      const c = [...r.querySelectorAll('td')].map(x => x.innerText.trim().replace(/\s+/g, ' '));
      if (c.length < 6 || /暂无内容|暂无数据/.test(r.innerText)) return null;
      return { regNo: c[1] || '', drugName: c[2] || '', drugType: c[3] || '', applyType: c[4] || '', regClass: c[5] || '', company: c[6] || '', date: c[7] || '' };
    }).filter(Boolean).filter(r => r.drugName);
  });
}

// 翻页（精确匹配"下一页"，避免误点"至末页"）
async function nextPage(page, cfg) {
  const before = await page.evaluate(FIRST_ROW);
  const clicked = await page.evaluate(() => {
    const el = [...document.querySelectorAll('a,li,button,span')].find(x => x.innerText.trim() === '下一页');
    if (!el) return false;
    el.click(); return true;
  });
  if (!clicked) return false;
  try {
    await page.waitForFunction((prev) => {
      const t = document.querySelectorAll('table')[0];
      const first = t && t.querySelector('tr:nth-child(2)');
      const txt = first ? first.innerText.slice(0, 120) : '';
      return txt && txt !== prev;
    }, before, { timeout: cfg.query_timeout_ms, polling: 300 });
  } catch (_) { return false; }
  await sleep(400);
  return true;
}

// ── 单品种富化（含翻页）──
async function enrichProduct(page, productName, opts = {}) {
  const cfg = { ...loadConfig(), ...(opts.config || {}) };
  const core = coreName(productName) || String(productName || '').trim();
  const entry = { core, source: 'cde', rules_version: RULES_VERSION, queried_at: new Date().toISOString().slice(0, 10), queries: 0, facts: {}, companies: {}, evidence: [], sources: ['cde.org.cn'], confidence: 'none', note: '' };
  try {
    const rows = [];
    let q = await queryProduct(page, String(productName).trim(), cfg, opts.defaultSig);
    entry.queries = 1;
    if (q.failed) {
      entry.note = '查询未生效（页面未就绪）→ 下次运行重试';
      entry.confidence = 'none';
      entry.queried_at = null;                       // 不写时间戳 → isFresh=false → 下次重试
      return entry;
    }
    rows.push(...q.rows);
    let pageRows = q.rows, pages = 1;
    while (pageRows.length >= (cfg.page_size - 1) && pages < (cfg.max_pages_per_product || 1)) {
      const ok = await nextPage(page, cfg);
      if (!ok) break;
      pageRows = await parseTable(page);
      entry.queries++;
      pages++;
      rows.push(...pageRows);
    }
    const d = deriveFacts(rows);
    entry.facts = d.facts;
    entry.companies = d.companies;
    entry.evidence = d.evidence;
    entry.note = d.summary;
    entry.confidence = d.hasSignal ? 'high' : (rows.length ? 'medium' : 'none');
  } catch (e) {
    entry.note = `查询失败: ${e.message}`;
    entry.confidence = 'none';
  }
  return entry;
}

// ── 批量富化（顺序执行，礼貌限速）──
async function enrichProducts(productNames, opts = {}) {
  const cfg = { ...loadConfig(), ...(opts.config || {}) };
  const cache = opts.cache || loadCache();
  const products = cache.products || (cache.products = {});
  const ttl = cfg.cache_ttl_days;
  const todo = productNames
    .map(n => ({ raw: n, core: coreName(n) || String(n).trim() }))
    .filter(x => x.core && (opts.force || !isFresh(products[x.core], ttl)));
  const budget = Number(opts.budget || cfg.max_products_per_run || 300);
  const run = todo.slice(0, budget).filter(x => x.core);
  const skippedBudget = Math.max(0, todo.length - run.length);
  if (!run.length) { console.log('  无待查品种（缓存均在有效期内）'); return { queried: 0, skippedBudget: 0, failed: 0 }; }

  console.log(`  CDE 待查 ${run.length} 个品种（缓存命中跳过 ${productNames.length - todo.length}，超预算跳过 ${skippedBudget}）`);
  const { browser, context, page } = opts.page ? { page: opts.page } : await connectBrowser();
  let queried = 0, failed = 0;
  try {
    await openForm(page);
    await setPageSize(page, cfg.page_size);
    const defaultSig = await page.evaluate(FIRST_ROW);      // 未筛选的默认列表指纹（用于识别"查询未生效"）
    for (const item of run) {
      const entry = await enrichProduct(page, item.raw, { config: cfg, defaultSig });
      products[item.core] = entry;
      queried++;
      if (entry.confidence === 'none') failed++;
      const tag = entry.confidence === 'high' ? '✅' : (entry.confidence === 'medium' ? '○' : '·');
      console.log(`  ${tag} ${item.raw} → ${entry.note || '无结果'}`);
      if (opts.onProgress) opts.onProgress(item.core, entry);
      saveCache(cache);                                    // 逐条落盘，中断可续
      const [lo, hi] = cfg.delay_between_products_ms;
      await sleep(lo + Math.random() * (hi - lo));
    }
  } finally {
    if (!opts.page) { try { await context.close(); } catch (_) {} }
  }
  saveCache(cache);
  return { queried, skippedBudget, failed };
}

// ── 待查品种（与博查同一目标集：API 中文名 + 真实试验产品核心名）──
// 为什么带产品名：CDE 检索是"药品名称"子串匹配，异体译名（如 布林唑胺/布林佐胺）或复方制剂
// 用 API 名会漏；用试验里出现的真实产品名召回更好，且命中即为产品级证据（归属更精确）。
function collectTargets(apis) {
  const nm = require('./nmpa-search');
  const names = new Set();
  Object.values(apis || {}).forEach(api => {
    if (!(api.results || []).length) return;      // 无试验的品种不进报告 → 不必查（FDA 清单里多为中国未上市品种）
    if (api.name_cn && nm.isQueryableProduct(api.name_cn)) names.add(api.name_cn);
    (api.results || []).forEach(t => { if (nm.isQueryableProduct(t.drugName)) names.add(nm.coreName(t.drugName)); });
  });
  return [...names];
}

// ── CLI ──
module.exports = { coreName, collectTargets, deriveFacts, enrichProduct, queryProduct, parseTableWithTotal, openForm, setPageSize, connectBrowser, FIRST_ROW, enrichProducts, loadCache, saveCache, loadConfig, isFresh, CACHE_FILE, CDE_URL };

if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const maxN = Number(getArg('--max') || 0) || undefined;
  const single = getArg('--product');

  (async () => {
    const cfg = loadConfig();
    if (args.includes('--stats')) {
      const c = loadCache();
      const vals = Object.values(c.products || {});
      const by = {};
      vals.forEach(e => { by[e.confidence] = (by[e.confidence] || 0) + 1; });
      console.log(`缓存品种: ${vals.length} | 置信度: ${JSON.stringify(by)} | 更新于 ${c.updated_at || '-'}`);
      return;
    }
    if (single) {
      const { page, context } = await connectBrowser();
      try {
        await openForm(page); await setPageSize(page, cfg.page_size);
        const defaultSig = await page.evaluate(FIRST_ROW);
        const e = await enrichProduct(page, single, { config: cfg, defaultSig });
        console.log(JSON.stringify(e, null, 2));
      } finally { try { await context.close(); } catch (_) {} }
      return;
    }
    const fda = JSON.parse(fs.readFileSync(path.join(WS, 'config', 'fda_nitrosamines.json'), 'utf8'));
    const targets = collectTargets(fda.apis);
    console.log(`CDE 目标品种 ${targets.length} 个 | 预算 ${maxN || cfg.max_products_per_run} | 每页 ${cfg.page_size} 条 / 最多翻 ${cfg.max_pages_per_product} 页`);
    const r = await enrichProducts(targets, { budget: maxN });
    const c = loadCache();
    const vals = Object.values(c.products || {});
    console.log(`\n完成: 新查询 ${r.queried} | 失败/无结果 ${r.failed} | 缓存品种 ${vals.length} | 有信号 ${vals.filter(e => e.confidence === 'high').length} | 超预算跳过 ${r.skippedBudget}`);
  })().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
}