#!/usr/bin/env node
/**
 * 法规分类富化：用博查（Bocha）搜索抽取 NMPA 注册分类 / 一致性评价证据（场景无关）
 *
 * 背景：临床试验登记数据里没有 NMPA 注册分类（1类创新药/2类改良型/3-4类仿制）与
 *       一致性评价状态，而这两个字段对判断"变更窗口"极有价值。官方接口（datasearch）
 *       需要 sign 签名 + 阿里云 WAF，故改用搜索证据抽取。
 *
 * 关键设计（实测踩坑后确定）：
 *   1) **品种名门控**：结果标题/摘要必须含品种核心名（去盐基前缀+剂型后缀），
 *      否则会拿到近似品种的证据（查"富马酸贝达喹啉片"会返回"富马酸卢帕他定片"）
 *   2) 两级查询：Web Search（便宜）→ 无明确证据时 AI Search 兜底（事实+引用更完整）
 *   3) 只存**结构化事实**（不是单一结论）：创新药/改良型/仿制类/过评/首仿，各自独立，
 *      混合品种（如拜耳原研 + 国内4类仿制）才不会互相覆盖
 *   4) 证据全部留痕（原始片段+URL+日期），AI 回答仅作辅助信号，置信度显式标注
 *   5) 结果缓存 config/nmpa_class_cache.json，增量运行只查新品种；单次运行有查询预算上限
 *
 * CLI（抽检/调试）：
 *   node scripts/lib/nmpa-search.js --sample 20          # 从当前快照抽 20 个品种做验收
 *   node scripts/lib/nmpa-search.js --product 非奈利酮片   # 查单个品种
 *   node scripts/lib/nmpa-search.js --stats              # 看缓存统计
 *
 * 环境变量：
 *   BOCHA_API_KEY   博查 API Key（未设时回退读取 ~/.pi/web-search.json 的 bochaApiKey）
 *   BOCHA_BUDGET    单次运行查询预算（默认取 config/nmpa-search.json）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const WS = path.resolve(__dirname, '..', '..');
const CONFIG_FILE = path.join(WS, 'config', 'nmpa-search.json');
const CACHE_FILE = path.join(WS, 'config', 'nmpa_class_cache.json');

// 抽取规则版本：规则变更时必须 +1，否则旧缓存里的错误结论会被当作有效证据复用
const RULES_VERSION = 4;

const DEFAULTS = {
  enabled: true,
  max_queries_per_run: 100,      // 单次运行查询预算（Web + AI 合计）
  cache_ttl_days: 90,            // 品种证据有效期
  delay_between_queries_ms: 1500,
  ai_search_escalation: false,   // Web 无明确证据时是否用 AI Search 兜底（实测收益低、成本翻倍，默认关）
  only_unresolved: true          // 只查"规则无法确定/需验证"的品种
};

// ── 配置与凭据 ──
function loadConfig() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}

function getApiKey() {
  if (process.env.BOCHA_API_KEY) return process.env.BOCHA_API_KEY;
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.pi', 'web-search.json'), 'utf8')).bochaApiKey || null;
  } catch { return null; }
}

// ── 品种核心名：去盐基前缀 + 去剂型后缀（用于门控与缓存键）──
const SALT_PREFIX = /^(富马酸|盐酸|氢溴酸|硫酸|苯磺酸|草酸|马来酸|酒石酸|枸橼酸|醋酸|磷酸|甲磺酸|琥珀酸|乳酸|门冬氨酸|双氯芬酸|硝酸|葡萄糖酸)+/;
const FORM_SUFFIX = /(雾化吸入|吸入用|注射用|口服溶液|口服液|肠溶片|缓释片|控释片|分散片|口崩片|咀嚼片|薄膜衣片|糖衣片|软胶囊|胶囊|片|颗粒|注射液|注射剂|滴眼液|气雾剂|吸入剂|喷雾剂|鼻喷剂|乳膏|凝胶|搽剂|栓剂|栓|贴剂|贴片|糖浆|混悬液|乳剂|溶液|滴剂|散剂|散|丸|膜|吸入|口服)$/;

function coreName(productName) {
  let s = String(productName || '').replace(/\s/g, '').replace(/（.*?）|\(.*?\)/g, '');
  s = s.replace(/^(注射用|吸入用|复方)+/, '');
  let prev;
  do {   // 反复剥离，直到稳定（如 "吸入用硫酸沙丁胺醇溶液" → "沙丁胺醇"）
    prev = s;
    s = s.replace(FORM_SUFFIX, '').replace(SALT_PREFIX, '');
  } while (s !== prev && s.length > 2);
  return s;
}

// ── 证据抽取 ──
const PATTERNS = [
  { key: 'innovative',     re: /(?:1类|一类)(?:创新药|新药)|注册分类[:：]?\s*1\s*类|批准[^。]{0,20}(?:1类|一类)创新药/ },
  { key: 'improved',       re: /(?:2\.[12]|2)\s*类改良型新药|改良型新药/ },
  { key: 'genericClass34', re: /化学药品\s*([34])\s*类|化药\s*([34])\s*类|注册分类[:：]?\s*([34])\s*类|([34])\s*类仿制药/ },
  { key: 'iec',            re: /(?<!未)(?:视同通过|通过)(?:仿制药质量和疗效)?一致性评价/ },
  { key: 'firstGeneric',   re: /首仿|首家过评|首家通过一致性评价|国内首家/ }
];

function extractFacts(title, snippet) {
  const text = `${title || ''} ${snippet || ''}`.replace(/\s+/g, ' ');
  const facts = {};
  for (const p of PATTERNS) {
    const m = text.match(p.re);
    if (m) facts[p.key] = m[0].slice(0, 40);
  }
  return { facts, text };
}

// 门控：标题/摘要必须含品种核心名
function passesGate(text, core) {
  return core.length >= 2 && text.includes(core);
}

// ── HTTP ──
function httpPost(pathname, body, timeoutMs = 45000) {
  const key = getApiKey();
  if (!key) return Promise.reject(new Error('缺少博查 API Key（设置 BOCHA_API_KEY 或 ~/.pi/web-search.json）'));
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.bochaai.com', path: pathname, method: 'POST', timeout: timeoutMs,
      headers: {
        'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, res => {
      let s = '';
      res.on('data', d => s += d);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${s.slice(0, 150)}`));
        try { resolve(JSON.parse(s)); } catch (e) { reject(new Error(`非 JSON 响应: ${s.slice(0, 120)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.write(data); req.end();
  });
}

const webSearch = (query, count = 10) => httpPost('/v1/web-search', { query, count, summary: false });
const aiSearch = (query) => httpPost('/v1/ai-search', { query, stream: false }, 60000);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── AI 回答处理：去提问模板 + 否定句过滤 + 仅接受正向断言 ──
// 踩过的坑：AI 常把我们的提问复述一遍（"未提及 XX 是几类药品（1类创新药/2类改良型新药/3类或4类仿制药）"），
// 直接用宽松正则会把复述的选项当成答案 → 必须先去模板 + 否定句直接丢弃。
const NEGATION = /未(?:能|经)?(?:明确|提及|提到|找到|给出|说明|包含|提供|收录)|无法(?:确定|准确|判断|明确)|没有(?:找到|提到|提及)|暂无|不包含|不确定|无相关|no information|not mention/i;

function cleanAiAnswer(answer) {
  let s = String(answer || '');
  // 去掉提问模板括号（含选项列表）
  s = s.replace(/[（(][^）)]*(?:1类创新药|3类或4类仿制药)[^）)]*[）)]/g, ' ');
  ['是几类药品', '1类创新药', '2类改良型新药', '3类或4类仿制药', '是否通过或视同通过一致性评价', '首仿企业是谁'].forEach(t => { s = s.split(t).join(' '); });
  s = s.replace(/\[[^\]]*\]/g, ' ');                       // 去掉 JSON 数组（追问建议/引用块）
  // 丢掉疑问句（提问式表述不是事实断言）
  s = s.split(/[。；;\n]/).map(x => x.trim()).filter(x => x && !/[?？]\s*$/.test(x)).join('。');
  return s.replace(/\s+/g, ' ').trim();
}

// 逐句抽取：事实必须出现在含该品种名的句子里（窗口 ±1 句），且该句不能是否定句
// （踩坑：AI 会把"未提及 XX 是几类药品"和"其他品种已过评"写在同一段 → 全局抽取会假阳性）
function aiAssertions(rawAnswer, core) {
  const answer = cleanAiAnswer(rawAnswer);
  const facts = {};
  if (!answer) return facts;
  const sentences = answer.split(/[。；;\n]|\[\d+\]/).map(s => s.trim()).filter(Boolean);
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    const prev = sentences[i - 1] || '';
    // 事实必须出现在含品种名的句子；或紧接前一句提到品种名且本句用代词指代（"该品种/本品"）
    const selfRef = s.includes(core) || (/(该品种|本品|该药|其)/.test(s) && prev.includes(core));
    if (!selfRef) continue;
    if (NEGATION.test(s)) continue;                        // 该句是否定句 → 跳过
    const mIec = s.match(/(?:视同)?通过(?:仿制药(?:质量和疗效)?)?一致性评价/);
    const mFirst = s.match(/首仿|首家过评|首家通过一致性评价/);
    if (mIec) facts.aiIec = mIec[0];
    if (mFirst) facts.aiFirstGeneric = mFirst[0];
    // 化学药品N类 / 化药N类（最可靠）
    const mChem = s.match(/(?:化学药品|化药)\s*([1-5](?:\.[12])?)\s*类/);
    if (mChem) {
      if (mChem[1].startsWith('1')) facts.aiInnovative = mChem[0];
      else if (mChem[1].startsWith('2')) facts.aiImproved = mChem[0];
      else facts.aiGeneric = mChem[0];
    }
    // "N类创新药/仿制药/药品"（但要排除 "N类精神药品" 这类非注册分类表述）
    const mCls = s.match(/([1-5](?:\.[12])?)\s*类\s*(创新药|改良型新药|仿制药)/);
    if (mCls) {
      if (/创新药/.test(mCls[0])) facts.aiInnovative = mCls[0];
      else if (/改良型/.test(mCls[0])) facts.aiImproved = mCls[0];
      else facts.aiGeneric = mCls[0];
    }
  }
  return facts;
}

// ── 单品种富化（两级查询）──
// 返回 { core, queried_at, queries, facts, sources, aiAnswer, confidence, note }
async function enrichProduct(productName, opts = {}) {
  const cfg = { ...loadConfig(), ...opts };
  const useAi = opts.ai_search_escalation === undefined ? cfg.ai_search_escalation : opts.ai_search_escalation;
  const core = coreName(productName);
  const out = { core, rules_version: RULES_VERSION, queried_at: new Date().toISOString().slice(0, 10), queries: 0, facts: {}, sources: [], evidence: [], aiAnswer: '', confidence: 'none', note: '' };

  // ① Web Search（两轮）：综合关键词 → 无证据时改用聚焦"过评/公告"查询
  const webQueries = [
    `"${core}" 注册分类 一致性评价 视同通过`,
    `"${core}" 通过一致性评价 公告 获批`
  ];
  for (const webQuery of webQueries) {
    if (Object.keys(out.facts).length > 0) break;         // 已有证据则不浪费第二次查询
    const r = await webSearch(webQuery, 10);
    out.queries++;
    const pages = r?.data?.webPages?.value || r?.data?.value || [];
    for (const p of pages) {
      if (!p.url) continue;
      const { facts, text } = extractFacts(p.name, p.snippet || p.summary || '');
      if (!Object.keys(facts).length) continue;
      if (!passesGate(text, core)) continue;              // ← 品种名门控
      Object.assign(out.facts, facts);
      out.sources.push(p.url);
      out.evidence.push({ url: p.url, text: text.slice(0, 160), facts: Object.keys(facts) });
    }
  }

  // ② AI Search 兜底（Web 无实质证据时）
  const hasWebEvidence = Object.keys(out.facts).length > 0;
  if ((!hasWebEvidence || opts.forceAi) && useAi) {
    const aiQuery = `${core}是几类药品？（1类创新药/2类改良型新药/3类或4类仿制药），是否通过或视同通过一致性评价？首仿企业是谁？`;
    const ai = await aiSearch(aiQuery);
    out.queries++;
    const msgs = ai.messages || [];
    // 引用片段（含结构化 JSON 的那些 message）
    const cites = [];
    for (const m of msgs) {
      const c = String(m.content || '');
      if (c.trim().startsWith('{')) {
        try { (JSON.parse(c).value || []).forEach(v => cites.push(v)); } catch (_) {}
      } else if (c.trim()) {
        // 跳过"追问建议"数组（形如 ["XX通过一致性评价有何影响？", ...]）——它不是断言，且会带品种名+关键词造成假阳性
        if (c.trim().startsWith('[')) continue;
        out.aiAnswer = `${out.aiAnswer} ${c}`.trim();
      }
    }
    for (const v of cites) {
      const { facts, text } = extractFacts(v.name, v.snippet || v.summary || '');
      if (!Object.keys(facts).length || !passesGate(text, core)) continue;
      Object.assign(out.facts, facts);
      if (v.url) out.sources.push(v.url);
      out.evidence.push({ url: v.url || '', text: text.slice(0, 160), facts: Object.keys(facts), via: 'ai-search' });
    }
    // AI 回答本身作为信号（去模板 + 否定句过滤 + 正向断言，见 aiAssertions）
    const aiFacts = aiAssertions(out.aiAnswer, core);
    Object.assign(out.facts, aiFacts);
    out.aiAnswer = cleanAiAnswer(out.aiAnswer).slice(0, 300);
  }

  // ③ 置信度
  const f = out.facts;
  if (f.innovative || f.genericClass34 || f.iec || f.firstGeneric) out.confidence = 'high';
  else if (f.improved || f.aiGeneric || f.aiInnovative || f.aiImproved || f.aiIec || f.aiFirstGeneric) out.confidence = 'medium';
  else out.confidence = 'none';
  return out;
}

// ── 缓存 ──
function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch { return { updated_at: null, products: {} }; }
}

function saveCache(cache) {
  cache.updated_at = new Date().toISOString().slice(0, 10);
  const tmp = CACHE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, CACHE_FILE);
}

function isFresh(entry, ttlDays) {
  if (!entry || !entry.queried_at) return false;
  if (entry.rules_version !== RULES_VERSION) return false;   // 规则已升级 → 旧证据失效
  const age = (Date.now() - new Date(entry.queried_at).getTime()) / 86400000;
  return age < ttlDays;
}

/**
 * 批量富化（缓存优先、预算受限）
 * @param {string[]} productNames
 * @param {{onProgress?:Function, budget?:number, force?:boolean}} opts
 * @returns {Promise<{cache, queried:number, skippedBudget:number, hits:number}>}
 */
async function enrichProducts(productNames, opts = {}) {
  const cfg = loadConfig();
  const budget = opts.budget || cfg.max_queries_per_run;
  const cache = loadCache();
  let queried = 0, skippedBudget = 0, hits = 0;

  const cores = [...new Set(productNames.map(coreName).filter(n => n && n.length >= 2))];
  for (const core of cores) {
    const cached = cache.products[core];
    if (!opts.force && isFresh(cached, cfg.cache_ttl_days)) { if (cached.confidence !== 'none') hits++; continue; }
    if (queried >= budget) { skippedBudget++; continue; }
    try {
      const entry = await enrichProduct(core);
      cache.products[core] = entry;
      queried += entry.queries;
      if (entry.confidence !== 'none') hits++;
      if (opts.onProgress) opts.onProgress(core, entry);
      await sleep(cfg.delay_between_queries_ms);
    } catch (e) {
      cache.products[core] = { core, rules_version: RULES_VERSION, queried_at: new Date().toISOString().slice(0, 10), queries: 0, facts: {}, sources: [], evidence: [], confidence: 'none', note: `查询失败: ${e.message}` };
      if (opts.onProgress) opts.onProgress(core, cache.products[core]);
    }
  }
  saveCache(cache);
  return { cache, queried, skippedBudget, hits, total: cores.length };
}

// ── 判定（供分类使用）：从 facts 推导可用的分类信号 ──
function classifyFacts(entry) {
  const f = (entry && entry.facts) || {};
  return {
    innovative: !!(f.innovative || f.aiInnovative),
    improved: !!(f.improved || f.aiImproved),
    generic: !!(f.genericClass34 || f.iec || f.firstGeneric || f.aiGeneric || f.aiIec || f.aiFirstGeneric),
    iecPassed: !!(f.iec || f.aiIec),
    regClass: f.genericClass34 ? (String(f.genericClass34).match(/[34]/) || [])[0] : (f.innovative ? '1' : (f.improved ? '2' : ''))
  };
}

// ── 品种名是否值得查询（排除英文干预名/试验标签/代码号，避免烧预算）──
const BAD_NAME = /^(Experimental|Placebo|Sequence|Group|Arm|Part|Cohort|Dose|Treatment|Comparator|Combination|Standard)/i;
function isQueryableProduct(name) {
  const s = String(name || '').trim();
  if (s.length < 2 || BAD_NAME.test(s)) return false;
  const core = coreName(s);
  // 核心名必须是纯中文且≥2字（过滤 "SHR-9839"、"TQC3927"、英文干预名等）
  return /^[\u4e00-\u9fff]{2,}$/.test(core);
}

// ── CLI ──
if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };

  (async () => {
    if (!getApiKey()) { console.error('❌ 缺少博查 API Key（BOCHA_API_KEY 或 ~/.pi/web-search.json）'); process.exit(1); }

    if (args.includes('--stats')) {
      const c = loadCache();
      const list = Object.values(c.products);
      const byConf = {};
      list.forEach(p => { byConf[p.confidence] = (byConf[p.confidence] || 0) + 1; });
      console.log(`缓存品种: ${list.length} | 置信度: ${JSON.stringify(byConf)} | 更新于 ${c.updated_at}`);
      return;
    }

    const single = getArg('--product');
    if (single) {
      const e = await enrichProduct(single, { forceAi: true });
      console.log(JSON.stringify(e, null, 2));
      return;
    }

    // 抽检：从当前快照取品种（seed 在目标池处声明）
    const snapFile = (() => {
      const dir = path.join(WS, 'output', 'runs');
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort() : [];
      return files.length ? path.join(dir, files[files.length - 1]) : null;
    })();
    if (!snapFile) { console.error('❌ 未找到快照 output/runs/YYYY-MM-DD.json'); process.exit(1); }

    const { buildLeadModel } = require('./report');
    const scenarioDir = path.join(WS, 'scenarios', 'nitrosamine');
    const config = JSON.parse(fs.readFileSync(path.join(scenarioDir, 'scenario.json'), 'utf8'));
    const hooks = require(path.join(scenarioDir, 'enrich.js'));
    const ctx = buildLeadModel(JSON.parse(fs.readFileSync(snapFile, 'utf8')), { config, hooks }, true);

    // 品种 → 规则推断分类（保留用于对照：看搜索结果是否修正了规则推断）
    const byCore = new Map();
    Object.values(ctx.enrichedApis).forEach(a => a.trials.forEach(t => {
      const core = coreName(t.drugName);
      if (!core || core.length < 2) return;
      if (!byCore.has(core)) byCore.set(core, { rule: {}, samples: [] });
      const e = byCore.get(core);
      const c = t.drugClassification || '未分类';
      e.rule[c] = (e.rule[c] || 0) + 1;
      if (e.samples.length < 1) e.samples.push(`${t.sponsor || ''}|${t.drugName}|${t.phase || ''}`);
    }));

    // ── 抽检目标池 ──
    // ① API 中文名（NMPA 数据按中文通用名索引，是权威查询键）
    // ② 中文产品名（复方/成盐品种补充，且必须像“真药名”——过滤英文干预名/试验标签）
    const fdaCache = JSON.parse(fs.readFileSync(path.join(WS, 'config', 'fda_nitrosamines.json'), 'utf8'));
    const apiNames = [...new Set(Object.values(fdaCache.apis).map(a => a.name_cn).filter(isQueryableProduct))].sort();
    const productCores = [...new Set(Object.values(ctx.enrichedApis).flatMap(a => a.trials.map(t => t.drugName)).filter(isQueryableProduct).map(coreName))];

    const seed = Number(getArg('--sample') || 20);
    const allApi = args.includes('--all-api');
    const noAi = args.includes('--no-ai');
    const force = args.includes('--force');
    const topN = Number(getArg('--top') || 0);
    let picked;

    // 价值导向抽样：按商机条数 Top-N 的 API（报告里最要紧的那批）
    if (topN) {
      const leadsByApi = Object.values(ctx.enrichedApis)
        .map(a => ({ cn: a.name_cn || a.name_en, en: a.name_en, leads: a.trialCount, sponsorCount: a.sponsorCount, api: a }))
        .filter(x => isQueryableProduct(x.cn))
        .sort((a, b) => b.leads - a.leads)
        .slice(0, topN);
      picked = leadsByApi.map(x => ({ name: x.cn, kind: 'API', meta: x }));
      console.log(`Top-${picked.length} 商机 API（Web Search${noAi ? ' 独用' : ' + AI 兜底'}）\n`);
    } else if (allApi) {
      picked = apiNames.map(n => ({ name: n, kind: 'API' }));
      console.log(`全量模式：${picked.length} 个 API 中文名\n`);
    } else {
      // 等距抽样，避免只拿到字母序靠前的品种
      const stride = Math.max(1, Math.floor(apiNames.length / Math.ceil(seed * 0.7)));
      const apiPick = apiNames.filter((_, i) => i % stride === 0).slice(0, Math.ceil(seed * 0.7));
      const prodPick = productCores.filter(p => !apiPick.includes(coreName(p))).slice(0, seed - apiPick.length);
      picked = [...apiPick.map(n => ({ name: n, kind: 'API' })), ...prodPick.map(n => ({ name: n, kind: '产品' }))];
      console.log(`抽检 ${picked.length} 个品种（快照 ${path.basename(snapFile)}；API ${apiPick.length} + 产品 ${prodPick.length}）\n`);
    }

    const cache = loadCache();
    let i = 0, stat = { high: 0, medium: 0, none: 0 };
    for (const { name, kind } of picked) {
      i++;
      const core = coreName(name);
      let entry = cache.products[core];
      const fresh = isFresh(entry, loadConfig().cache_ttl_days);
      if ((!fresh && !args.includes('--use-cache')) || force) {
        try { entry = await enrichProduct(name, { ai_search_escalation: !noAi }); cache.products[core] = entry; }
        catch (err) { entry = { core, confidence: 'none', facts: {}, note: err.message, evidence: [], sources: [] }; }
        await sleep(loadConfig().delay_between_queries_ms);
      }
      if (!entry) { console.log(`${String(i).padStart(2)}. 【${core}】无缓存，跳过`); continue; }
      stat[entry.confidence] = (stat[entry.confidence] || 0) + 1;
      const v = classifyFacts(entry);
      const verdict = [v.innovative ? '创新药' : '', v.improved ? '改良型新药' : '', v.generic ? `仿制药${v.iecPassed ? '(过评)' : ''}` : ''].filter(Boolean).join(' + ') || '无明确证据';
      const ruleLbl = byCore.get(core) ? Object.entries(byCore.get(core).rule).sort((a, b) => b[1] - a[1])[0][0] : '-';
      // 价值评估：该 API 的商机行里,有多少会被搜索证据改动
      let impact = '';
      const meta = picked.find(x => coreName(x.name) === core && x.meta)?.meta;
      if (meta && meta.api) {
        const cls = meta.api.classificationCounts || {};
        const changeable = (cls['新药'] || 0) + (cls['未分类'] || 0);
        const vG = classifyFacts(entry).generic, vI = classifyFacts(entry).innovative;
        const wouldChange = vG ? changeable : 0;
        impact = ` | 商机${meta.leads}条/企业${meta.sponsorCount}家 当前分类:${Object.entries(cls).map(([k, v]) => k + v).join(' ')}${wouldChange ? ` → 预计改判 ${wouldChange} 条为仿制药` : ''}`;
      }
      console.log(`${String(i).padStart(2)}. 【${core}】(${kind})→${verdict}${entry.confidence === 'none' ? ' ⚪️' : ' ✅'}${fresh && !force ? '[缓存]' : ''}${impact}`);
      const facts = Object.entries(entry.facts || {}).map(([k, x]) => `${k}=${String(x).slice(0, 26)}`);
      if (facts.length) console.log(`     事实: ${facts.join(' | ')}`);
      if (entry.aiAnswer) console.log(`     AI: ${String(entry.aiAnswer).slice(0, 130)}`);
      if (entry.evidence && entry.evidence[0]) console.log(`     证据: ${String(entry.evidence[0].url).slice(0, 64)}\n           ${String(entry.evidence[0].text).slice(0, 105)}`);
    }
    saveCache(cache);
    console.log(`\n完成：高置信 ${stat.high} / 中置信 ${stat.medium} / 无证据 ${stat.none}（缓存: ${CACHE_FILE}）`);
  })().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
}

module.exports = { coreName, extractFacts, classifyFacts, enrichProduct, enrichProducts, loadCache, saveCache, loadConfig, getApiKey, isQueryableProduct, aiAssertions, cleanAiAnswer, CACHE_FILE };