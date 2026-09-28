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
const RULES_VERSION = 2;   // v2: 产品级证据 + 类型感知分类解析（旧缓存失效重查）   // 规则变更 → 旧证据自动失效

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
// ── 注册分类解析（含子类 + 按药品类型语义）──
// 权威依据：
//  化药《化学药品注册分类及申报资料要求》2020年第44号
//    1类 境内外均未上市创新药 ｜ 2类 境内外均未上市改良型新药
//      2.1 已知活性成份的光学异构体/成酯/成盐/改酸碱基金属/非共价键衍生物
//      2.2 已知活性成份的新剂型（含新给药系统）、新处方工艺、新给药途径
//      2.3 已知活性成份的新复方制剂 ｜ 2.4 已知活性成份的新适应症
//    3类 境内仿制"境外上市但境内未上市"原研药品 ｜ 4类 境内仿制"已在境内上市"原研药品
//    5类 境外已上市境内未上市：5.1 境外上市原研药品申请境内上市 ｜ 5.2 境外上市非原研（仿制）药品申请境内上市
//  生物制品（2020年第43号）：1类 创新型 ｜ 2类 改良型 ｜ 3类 境内或境外已上市生物制品
//    3.1 境外生产境外已上市境内未上市申报上市 ｜ 3.2 境外已上市境内未上市申报境内生产上市
//    3.3 生物类似药 ｜ 3.4 其他
//  中药（2020年第68号）：1类 创新药 ｜ 2类 改良型新药 ｜ 3类 古代经典名方中药复方制剂 ｜ 4类 同名同方药
//  旧分类（2020-07-01 前受理，平台显示"原X"）：原1/原3/原5 新药 ｜ 原2/原4 新药（改良型）｜ 原6 仿制药
//
// 返回 { code: 展示用完整分类（含子类）, signal: 'innovative'|'improved'|'generic'|'originator'|'' }
function parseClass(raw, drugType) {
  const s = String(raw || '').trim();
  if (!s) return { code: '', signal: '' };
  const type = /中药/.test(String(drugType || '')) ? 'tcm'
    : /生物|疫苗|细胞|基因/.test(String(drugType || '')) ? 'bio' : 'chem';

  if (/^原/.test(s)) {                       // 旧分类
    const n = (s.match(/[0-9]/) || [])[0];
    if (!n) return { code: s, signal: '' };
    if (n === '6') return { code: '原6', signal: 'generic' };
    if (n === '2' || n === '4') return { code: '原' + n, signal: 'improved' };
    return { code: '原' + n, signal: 'innovative' };
  }

  const code = (s.match(/^[1-5](\.[0-9])?/) || [])[0] || '';
  if (!code) return { code: s, signal: '' };
  const major = code[0];

  if (type === 'tcm') {
    if (major === '1') return { code, signal: 'innovative' };
    if (major === '2') return { code, signal: 'improved' };
    if (major === '3') return { code, signal: 'innovative' };   // 古代经典名方 ≠ 仿制
    if (major === '4') return { code, signal: 'generic' };      // 同名同方药
    return { code, signal: '' };
  }
  if (type === 'bio') {
    if (major === '1') return { code, signal: 'innovative' };
    if (major === '2') return { code, signal: 'improved' };
    if (code === '3.3') return { code, signal: 'generic' };     // 生物类似药
    if (major === '3') return { code, signal: 'originator' };   // 进口/其他已上市生物制品
    return { code, signal: '' };
  }
  // 化药
  if (major === '1') return { code, signal: 'innovative' };
  if (major === '2') return { code, signal: 'improved' };
  if (major === '3' || major === '4') return { code, signal: 'generic' };
  if (code === '5.1') return { code, signal: 'originator' };
  if (code === '5.2') return { code, signal: 'generic' };
  return { code, signal: '' };
}

/**
 * 从受理记录行推导分类事实（**产品级 + 品种级两套**）
 *
 * 为什么要产品级：CDE 按"药品名称"子串检索，查"沙丁胺醇"会同时返回
 * 「硫酸沙丁胺醇片(4类仿制)」和「盐酸左沙丁胺醇异丙托溴铵吸入溶液(2.1类新药)」——
 * 只做品种级聚合会把改良型新药误判成仿制药。故按药品名称聚合出 products 映射，
 * 挂证据时优先用"试验产品精确命中"的那一条。
 *
 * facts 键与 nmpa-search 兼容：genericClass34 / regClassDisp / iec / innovative / improved / originator
 */
function deriveFacts(rows) {
  const genericCodes = new Set();
  const companies = {};            // 企业 → 分类集合（供"同企业"证据展示）
  const products = {};             // 药品名称 → { code, signal, applyType, company, date, iec }
  const evidence = [];
  let iec = false, innovative = false, improved = false, originator = false, classed = 0;

  for (const r of rows) {
    const parsed = parseClass(r.regClass, r.drugType);
    const co = baseCompany(r.company);
    const rowIec = /一致性评价/.test(r.applyType || '');
    let signal = parsed.signal;
    if (!signal && /仿制/.test(r.applyType || '')) signal = 'generic';   // 申请类型=仿制但分类空
    if (rowIec) iec = true;

    if (signal) {
      classed++;
      if (signal === 'generic') genericCodes.add(parsed.code || '仿制');
      else if (signal === 'improved') improved = true;
      else if (signal === 'innovative') innovative = true;
      else if (signal === 'originator') originator = true;
    }
    if (co) companies[co] = [...new Set([...(companies[co] || []), parsed.code || (r.applyType || '').slice(0, 6)])];

    // 产品级：同一药品名称只保留最强信号（仿制 > 改良 > 创新？不——按该产品自己的分类，取首个有分类的行）
    const pname = String(r.drugName || '').trim();
    if (pname && (!products[pname] || (!products[pname].code && parsed.code))) {
      products[pname] = { code: parsed.code || '', signal, applyType: r.applyType || '', company: co, date: r.date || '', iec: rowIec };
    }
    if (evidence.length < 40) evidence.push({ text: [r.drugName, parsed.code ? parsed.code + '类' : '', r.applyType, co, r.date].filter(Boolean).join(' · '), url: '' });
  }

  // 品种级展示码：仿制 > 改良 > 创新 > 进口原研
  const order = ['4', '3', '5.2', '3.3', '原6', '仿制'];
  const dispGeneric = order.find(c => genericCodes.has(c)) || (genericCodes.size ? [...genericCodes][0] : '');
  const dispClass = dispGeneric || (improved ? '2' : (innovative ? '1' : (originator ? '5.1' : '')));

  const facts = {
    genericClass34: dispGeneric,
    regClassDisp: dispClass,
    ...(iec ? { iec: true } : {}),
    ...(innovative ? { innovative: true } : {}),
    ...(improved ? { improved: true } : {}),
    ...(originator ? { originator: true } : {}),
    totalRows: rows.length,
    classedRows: classed
  };
  const parts = [
    rows.length ? `CDE受理${rows.length}条` : '',
    Object.keys(products).length > 1 ? `${Object.keys(products).length}个产品` : '',
    dispGeneric ? `${dispGeneric}类仿制` : '',
    improved ? '2类改良' : '', innovative ? '1类创新' : '', originator ? '进口原研' : '', iec ? '一致性评价申报' : ''
  ].filter(Boolean);
  return { facts, products, companies, evidence, summary: parts.join(' / '), hasSignal: !!(dispGeneric || iec || innovative || improved || originator) };
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
    entry.products = d.products;      // 产品级证据（挂证据时优先精确命中）
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
module.exports = { coreName, collectTargets, deriveFacts, parseClass, enrichProduct, queryProduct, parseTableWithTotal, openForm, setPageSize, connectBrowser, FIRST_ROW, enrichProducts, loadCache, saveCache, loadConfig, isFresh, CACHE_FILE, CDE_URL };

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