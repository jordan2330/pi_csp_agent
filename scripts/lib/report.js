/**
 * 通用报告渲染器（场景无关）
 *
 * 由 scenario.json（声明式配置）+ scenario/enrich.js（命令式 hooks）驱动。
 * 职责：加载缓存 + 快照 → 富化 trial（剂型/药物分类）→ 聚合 → 渲染 Markdown。
 *
 * 与重构前的报告输出差异（刻意）：
 *   - 表格分隔线按表头宽度自动生成（原为手写固定宽度；Markdown 渲染相同）
 *   - 其余逐字移植，保证数据零回归
 *
 * 可独立运行以验证：
 *   node scripts/lib/report.js [nitrosamine]
 */

const fs = require('fs');
const path = require('path');
const { resolveDosageForm, isOralSolid, isEnterprise, dosageFormGroup } = require('./enrichment');

const WS = path.resolve(__dirname, '..', '..'); // 仓库根目录（本地运行，非容器 /workspace）

// ── Helpers ──
function truncate(s, max) {
  if (!s) return '-';
  return s.length > max ? s.substring(0, max - 1) + '…' : s;
}

function formatContact(t) {
  const parts = [];
  if (t.contactName) parts.push(t.contactName);
  if (t.contactPhone) parts.push(t.contactPhone);
  if (t.contactEmail) parts.push(t.contactEmail);
  const full = parts.join(' / ');
  return full.length > 80 ? full.substring(0, 79) + '…' : full;
}

function hasContact(t) {
  return !!(t.contactName || t.contactPhone || t.contactEmail);
}

function formBadge(form) {
  if (!form) return '-';
  if (isOralSolid(form)) return `**${form}**`;
  return form;
}

function parseDate(d) {
  if (!d) return null;
  const normalized = d.length === 7 ? d + '-01' : d;
  const parsed = new Date(normalized);
  return isNaN(parsed.getTime()) ? null : parsed;
}

// ── Phase ordering (CDT 中文 + CT.gov 英文) ──
const phaseOrder = {
  'III期': 0, 'IV期': 1, 'II期': 2, 'I期': 3, '其他-BE': 4, '其它': 5,
  'PHASE3': 0, 'PHASE4': 1, 'PHASE2': 2, 'PHASE2/PHASE3': 2,
  'PHASE1': 3, 'PHASE1/PHASE2': 3, 'EARLY_PHASE1': 4,
  'NA': 5, 'N/A': 5
};

function sortTrialsCDTFirst(trials) {
  return [...trials].sort((a, b) => {
    const aCDT = a.source === 'CDT' ? 0 : 1;
    const bCDT = b.source === 'CDT' ? 0 : 1;
    if (aCDT !== bCDT) return aCDT - bCDT;
    return (phaseOrder[a.phase] ?? 5) - (phaseOrder[b.phase] ?? 5);
  });
}

// ── Cell renderer ──
// 转义 | 和换行，防止标题/地址中的特殊字符撑破 Markdown 表格
function escapeCell(s) {
  return String(s).replace(/\|/g, '\|').replace(/\r?\n/g, ' ');
}

function buildLeadModel(snapshot, scenario, isFull) {
  const { config, hooks } = scenario;
  const today = new Date().toISOString().slice(0, 10);

  // ── Load data ──
  const fdaCache = JSON.parse(fs.readFileSync(path.join(WS, config.cache_file), 'utf8'));
  let apiTranslations = {};
  if (config.api_translations_file) {
    try { apiTranslations = JSON.parse(fs.readFileSync(path.join(WS, config.api_translations_file), 'utf8')); }
    catch (_) { /* optional */ }
  }
  const results = snapshot.trials_data.results;

  // 法规分类证据缓存（Phase 2c 产出；缺失/未启用时静默降级为规则推断）
  let nm = null, nmpaCache = { products: {} }, cdeCache = { products: {} };
  try { nm = require('./nmpa-search'); nmpaCache = nm.loadCache(); } catch (_) {}
  try { cdeCache = require('./cde-classify').loadCache(); } catch (_) {}

  // ── Build apiInfo ──
  const apiInfo = {};
  Object.entries(fdaCache.apis).forEach(([name, info]) => {
    apiInfo[name] = {
      name_cn: info.name_cn || apiTranslations[name] || name,
      potency_category: info.potency_category,
      ai_limit: info.ai_limit,
      nitrosamines: info.nitrosamines || []
    };
  });

  // ── Date filter（scenarios/<name>/scenario.json → lookback_years，默认 2 年）──
  const todayDate = new Date(today);
  const windowStart = new Date(todayDate);
  windowStart.setFullYear(todayDate.getFullYear() - (Number(config.lookback_years) || 2));

  // 窗口切分：窗口内 → P1/P2/统计；窗口外或归档行 → 仅「全部商机」（历史沉淀）
  const filteredResults = {}, historyResults = {};
  Object.entries(results).forEach(([apiName, trials]) => {
    const inWin = [], hist = [];
    (trials || []).forEach(t => {
      const regDate = parseDate(t.regDate);
      const ok = !t.archived && (!regDate || regDate >= windowStart);
      t.inWindow = ok;
      (ok ? inWin : hist).push(t);
    });
    filteredResults[apiName] = inWin;
    historyResults[apiName] = hist;
  });
  const apisWithLeads = Object.keys(filteredResults).filter(k => (filteredResults[k] || []).length > 0);
  // 渲染集合 = 有窗口内商机的 API ∪ 只有历史行的 API（历史行只进「全部商机」）
  const apisToRender = [...new Set([...apisWithLeads, ...Object.keys(historyResults).filter(k => (historyResults[k] || []).length > 0)])];

  // ── Enrich + aggregate ──
  const enrichedApis = {};
  let totalLeads = 0;
  let totalNewLeads = 0;

  apisToRender.forEach(apiName => {
    const rawTrials = [...(filteredResults[apiName] || []), ...(historyResults[apiName] || [])].map(t => {
      const dosageForm = resolveDosageForm(t);
      const nmpa = (() => {
        if (!nm) return null;
        const api = apiInfo[apiName] || {};
        const drugCore = nm.coreName(t.drugName);
        const cnCore = api.name_cn ? nm.coreName(api.name_cn) : '';
        const drugRaw = String(t.drugName || '');
        // 归属判定：试验药物必须"就是"该 API 品种（否则只是把该 API 当背景，如亚叶酸钙出现在双抗化疗方案里）
        const belongs = (cnCore && drugCore === cnCore)
          || (apiName && drugRaw.toLowerCase().includes(String(apiName).toLowerCase()))
          || (api.name_cn && drugRaw.includes(api.name_cn));
        // ① 产品级证据（试验品种精确命中）优先；② API 级证据仅在归属成立时使用
        // 证据优先级：CDE 官方受理数据（一手） > 博查搜索证据（二手）
        // 依次尝试：产品级证据 → API 级证据（仅当归属成立）；跳过 confidence=none 的条目
        // 注意必须"逐个校验后再回退"：产品级查到但无记录时也要回退到 API 级（否则漏证据）
        const pick = (cache, source) => {
          const cands = [cache.products[drugCore], (belongs && cnCore) ? cache.products[cnCore] : null];
          const e = cands.find(x => x && x.confidence !== 'none');
          return e ? { entry: e, source } : null;
        };
        const cdeHit = pick(cdeCache, 'cde');
        const bochaHit = pick(nmpaCache, 'bocha');
        if (!cdeHit && !bochaHit) return null;
        // 证据合并：注册分类/创新改良 以 CDE 官方为准（权威）；**一致性评价（过评）用博查补齐**
        // （CDE 受理目录只覆盖"按一致性评价申报"的受理记录，历史过评品种多在博查新闻里）
        const cdeFacts = (cdeHit && cdeHit.entry.facts) || {};
        const bochaFacts = (bochaHit && bochaHit.entry.facts) || {};
        const facts = { ...bochaFacts, ...cdeFacts };
        const iecFromBocha = !!(bochaFacts.iec && !cdeFacts.iec);
        if (iecFromBocha) facts.iec = true;
        const entry = (cdeHit || bochaHit).entry;
        const f = nm.classifyFacts({ facts });
        return {
          regClass: f.regClass || '', iec: f.iecPassed ? '通过/视同通过' : '',
          generic: f.generic, innovative: f.innovative, improved: f.improved,
          confidence: entry.confidence,
          source: cdeHit ? (bochaHit ? 'cde+bocha' : 'cde') : 'bocha',
          note: [entry.note || '', iecFromBocha ? '过评证据来自博查' : ''].filter(Boolean).join(' / '),
          url: ((cdeHit ? cdeHit.entry.sources : bochaHit.entry.sources) || [])[0] || '',
          evidence: ((entry.evidence || [])[0] || {}).text || ''
        };
      })();
      return {
        ...t,
        drugClassification: t.drugClassification || (hooks.classifyTrial ? hooks.classifyTrial(t) : null),
        nmpa,
        dosageForm,
        dosageGroup: dosageFormGroup(dosageForm, config),
        indication: t.indication || (t.source === 'CDT' ? t.briefTitle : (t.condition || t.briefTitle)) || '',
        phase: t.phase || ''
      };
    });

    // Enterprise filter: CDT trials are all pharma companies; CT.gov needs filtering
    const kept = rawTrials.filter(t => t.source === 'CDT' || isEnterprise(t.sponsor));
    // 活跃（窗口内）用于 P1/P2 与统计；historyTrials 只进「全部商机」（历史沉淀）
    const trials = kept.filter(t => t.inWindow !== false);
    const historyTrials = kept.filter(t => t.inWindow === false);
    if (trials.length === 0 && historyTrials.length === 0) return;

    const info = apiInfo[apiName] || { name_cn: apiTranslations[apiName] || apiName, potency_category: 5, ai_limit: '1500 ng/day' };
    const newTrials = trials.filter(t => t.isNew);
    totalLeads += trials.length;
    totalNewLeads += newTrials.length;

    const cdtTrials = trials.filter(t => t.source === 'CDT');
    const ctgovTrials = trials.filter(t => t.source !== 'CDT');
    const cdtSponsors = new Set(cdtTrials.map(t => t.sponsor).filter(Boolean));
    const allSponsors = new Set(trials.map(t => t.sponsor).filter(Boolean));

    // 剂型分组统计 → 主剂型（优先 OSD 相关分组：口服固体/改良释放/颗粒散剂）
    const groupCounts = {};
    trials.forEach(t => { if (t.dosageGroup && t.dosageGroup !== 'unknown') groupCounts[t.dosageGroup] = (groupCounts[t.dosageGroup] || 0) + 1; });
    const PRIORITY_GROUPS = ['osd', 'mr', 'granule'];
    const primaryGroup = PRIORITY_GROUPS.find(g => groupCounts[g])
      || (Object.entries(groupCounts).sort((a, b) => b[1] - a[1])[0] || ['unknown'])[0];

    // 药物分类分布
    const classificationCounts = {};
    trials.forEach(t => { const c = t.drugClassification || '未分类'; classificationCounts[c] = (classificationCounts[c] || 0) + 1; });

    // CSP 推荐：以剂型为主（返回 {text, confirm}）
    const partialApi = { potency_category: info.potency_category, dosageGroup: primaryGroup };
    const csp = hooks.recommendCSP ? hooks.recommendCSP(partialApi, config) : null;

    enrichedApis[apiName] = {
      name_en: apiName,
      name_cn: info.name_cn,
      potency_category: info.potency_category,
      ai_limit: info.ai_limit,
      csp_recommendation: csp ? csp.text : (config.category.csp_by_category[info.potency_category] || null),
      csp_confirm: csp ? csp.confirm : null,
      dosageGroup: primaryGroup,
      groupCounts,
      classificationCounts,
      trials,
      historyTrials,                 // 窗口外 / 已归档（仅「全部商机」渲染）
      cdtTrials,
      ctgovTrials,
      newTrials,
      trialCount: trials.length,
      newTrialCount: newTrials.length,
      cdtSponsors: [...cdtSponsors],
      allSponsors: [...allSponsors],
      sponsorCount: allSponsors.size,
      oralSolidCount: trials.filter(t => isOralSolid(t.dosageForm)).length
    };
  });

  // ── 场景级分类一致性修正（可选 hook）：同一产品跨试验/跨企业统一口径 ──
  if (hooks.refineClassifications) {
    try { hooks.refineClassifications(Object.values(enrichedApis).flatMap(a => [...a.trials, ...(a.historyTrials || [])])); }
    catch (e) { console.error('分类一致性修正失败:', e.message); }
  }

  // ── 分类依据标注（透明化：该行的分类标签是查证过的还是推断的）──
  //   搜索证据 = 标签与 NMPA 搜索证据一致（可查证）
  //   规则（证据不适用） = 该品种有证据，但因原研企业/代码号/改良型名称被排除
  //   规则推断 = 无可用证据
  for (const api of Object.values(enrichedApis)) {
    for (const t of [...api.trials, ...(api.historyTrials || [])]) {
      const n = t.nmpa;
      const cls = t.drugClassification || '未分类';
      if (!n) { t.classBasis = '规则推断'; continue; }
      const byEv = n.generic ? '仿制药' : (n.improved ? '新药（改良型）' : (n.innovative ? '新药' : null));
      t.classBasis = (byEv && cls === byEv)
        ? (String(n.source || '').startsWith('cde') ? '官方证据(CDE)' : '搜索证据')
        : '规则（证据不适用）';
    }
  }

  // ── Category grouping ──
  const byCat = {};
  config.category.order.forEach(c => { byCat[c] = []; });
  Object.values(enrichedApis).forEach(api => {
    const cat = api[config.category.field];
    if (byCat[cat]) byCat[cat].push(api);
  });
  Object.values(byCat).forEach(apis => apis.sort((a, b) => b.trialCount - a.trialCount));

  const newLeadApis = Object.values(enrichedApis)
    .filter(a => a.newTrialCount > 0)
    .sort((a, b) => b.newTrialCount - a.newTrialCount);

  // ── Global stats for overview ──
  const allSponsorsGlobal = new Set();
  Object.values(enrichedApis).forEach(a => a.allSponsors.forEach(s => allSponsorsGlobal.add(s)));
  let cdtCount = 0, ctgovCount = 0, cdtWithContact = 0, ctgovWithContact = 0, oralSolidCount = 0;
  Object.values(enrichedApis).forEach(a => {
    cdtCount += a.cdtTrials.length;
    ctgovCount += a.ctgovTrials.length;
    cdtWithContact += a.cdtTrials.filter(hasContact).length;
    ctgovWithContact += a.ctgovTrials.filter(hasContact).length;
    oralSolidCount += a.oralSolidCount;
  });

  const ctx = {
    snap: snapshot, config, today, totalLeads, totalNewLeads,
    apisWithLeadsCount: apisWithLeads.length, newLeadApisCount: newLeadApis.length,
    byCat, enrichedApis, newLeadApis, allSponsorsGlobalSize: allSponsorsGlobal.size,
    cdtCount, ctgovCount, cdtWithContact, ctgovWithContact, oralSolidCount
  };

  return ctx;
}

// ── Markdown 渲染 ──
module.exports = { buildLeadModel };
