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
        // 产品级证据匹配（v4.1.3 关键修复）：
        // CDE 按"药品名称"**子串**检索 → 一条 entry 可能含多个产品
        // （查"沙丁胺醇"会同时返回「硫酸沙丁胺醇片(4类仿制)」和「盐酸左沙丁胺醇异丙托溴铵吸入溶液(2.1类新药)」）。
        // 必须优先用"试验产品精确命中"的那条产品级证据，否则改良型新药会被品种级聚合误判成仿制药。
        const normName = (x) => String(x || '').replace(/[（(][^）)]*[）)]/g, '').replace(/\s+/g, '');
        const matchProduct = (entry, drugRaw) => {
          const prods = (entry && entry.products) || {};
          const nd = normName(drugRaw);
          if (!nd) return null;
          let best = null;
          for (const [name, pf] of Object.entries(prods)) {
            const nn = normName(name);
            if (!nn) continue;
            if (nn === nd) return { name, pf };
            if ((nd.includes(nn) || nn.includes(nd)) && (!best || nn.length > normName(best.name).length)) best = { name, pf };
          }
          return best;
        };
        const factsFromProduct = (pf) => ({
          regClassDisp: pf.code || '',
          genericClass34: pf.signal === 'generic' ? (pf.code || '仿制') : '',
          ...(pf.iec ? { iec: true } : {}),
          ...(pf.signal === 'improved' ? { improved: true } : {}),
          ...(pf.signal === 'innovative' ? { innovative: true } : {}),
          ...(pf.signal === 'originator' ? { originator: true } : {})
        });
        // 只用 CDE 官方证据（v4.2.0：博查二手搜索不再参与分类，模块/缓存保留备查）
        const pick = (cache) => {
          const cands = [cache.products[drugCore], (belongs && cnCore) ? cache.products[cnCore] : null];
          return cands.find(x => x && x.confidence !== 'none') || null;
        };
        const cdeHit = pick(cdeCache);
        if (!cdeHit) return null;
        const bochaHit = null;

        // 标签来源与"一致性评价"分开处理（v4.1.3）：
        //   标签/注册分类：产品级 CDE > 品种级 CDE > 博查（**不混用**，否则博查的品种级"过评"
        //    会把产品级 2.x 改良型新药又拉回"仿制药"）
        //   一致性评价列：产品级/品种级 CDE 或 博查 有其一即标注（列语义 = 该品种已有过评仿制）
        let facts = null, level = 'api', hitProduct = '';
        {
          const pm = matchProduct(cdeHit, t.drugName);
          if (pm && pm.pf && pm.pf.signal) { facts = factsFromProduct(pm.pf); level = 'product'; hitProduct = pm.name; }
          else { facts = cdeHit.facts || {}; }
        }
        const bochaFacts = (bochaHit && bochaHit.entry.facts) || {};
        const cdeFacts = cdeHit.facts || {};
        const uProd = level === 'product' ? nm.labelFromFacts(facts) : null;
        const uCde = nm.labelFromFacts(cdeFacts);
        const chosen = (uProd && uProd.label) ? { u: uProd, lvl: 'product' } : (uCde.label ? { u: uCde, lvl: 'api' } : null);
        const u = chosen ? chosen.u : { label: null, regClass: '', kind: 'none' };
        if (chosen) level = chosen.lvl;
        const entry = cdeHit;
        return {
          regClass: u.regClass || '', label: u.label || '', level, product: hitProduct,
          kind: u.kind,
          confidence: entry.confidence,
          note: [entry.note || '', hitProduct ? `产品级命中 ${hitProduct}` : ''].filter(Boolean).join(' / '),
          url: (entry.sources || [])[0] || '',
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
        // 分期列承载试验设计事实：观察性试验（注册平台 trialType=OBSERVATIONAL）显式标注
        phase: t.phase || (/OBSERVATIONAL/i.test(t.trialType || '') ? '观察性（非干预）' : '')
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
    trials.forEach(t => { const c = t.drugClassification || '未取得证据'; classificationCounts[c] = (classificationCounts[c] || 0) + 1; });

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
      if (!n) { t.classBasis = ''; continue; }
      const byEv = n.label || null;      // 与注册分类同源（labelFromFacts）
      // 分类依据 = 证据出处（只留实锤；无实锤/证据不适用则留空，不做推断）
      const applicable = !!(byEv && cls === byEv);
      t.classBasis = applicable ? (n.level === 'product' ? 'CDE 受理数据（产品级）' : 'CDE 受理数据（品种级）') : '';
      // 证据不适用（原研企业/代码号 → 品种级证据被跳过）时，注册分类也必须一并留空，避免"有分类无标签"
      if (!applicable) t.nmpa = { ...n, regClass: '' };
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

// 进行中/可介入的试验状态优先（销售时机信号）
const ACTIVE_STATUS = /进行中|招募|尚未招募|未招募|not yet recruiting|recruiting|active, not recruiting|enrolling/i;

// ── 把 model 变成"一行 = 一条商机"的扁平记录（交付层通用，原在 report-xlsx.js）──
// 同一试验（source + 登记号）可能命中多个 API（如复方制剂同时命中两个 API），
// 此处合并为一行，用「涉及API」列标注全部关联 API，风险等级取其中最高（Cat 最小）。
// scope='active' → 只取窗口内活跃商机（P1/P2 用）；scope='all' → 累积全量（全部商机用，含历史行）
function flattenTrials(ctx, scope = 'all') {
  const raw = [];
  let seq = 0;
  const apiEntries = Object.values(ctx.enrichedApis);
  apiEntries.forEach(api => {
    const trials = scope === 'active' ? api.trials : [...api.trials, ...(api.historyTrials || [])];
    trials.forEach(t => {
      seq++;
      raw.push({
        // 无登记号时用自增键，避免被误合并
        key: t.regNo ? `${t.source}|${t.regNo}` : `__no_regno_${seq}`,
        apiCn: api.name_cn || api.name_en,
        apiEn: api.name_en,
        catNum: api.potency_category,
        aiLimit: api.ai_limit,
        csp: api.csp_recommendation || '',
        confirm: api.csp_confirm || '',
        sponsor: t.sponsor || '',
        drugName: t.drugName || '',
        dosageForm: t.dosageForm || '',
        drugClass: t.drugClassification || '',       // 空 = 未取得实锤证据（不推断）
        classBasis: t.classBasis || '',
        regClass: (t.nmpa && t.nmpa.regClass) || '',
        status: t.status || '',
        indication: t.indication || t.briefTitle || '',
        phase: t.phase || '',
        regNo: t.regNo || '',
        regDate: t.regDate || '',
        contactName: t.contactName || '',
        contactPhone: t.contactPhone || '',
        contactEmail: t.contactEmail || '',
        contactAddress: t.contactAddress || '',
        source: t.source || '',
        // ★ 口径：相对上一次运行的新增【且在时间窗内】。
        // 已过窗口/已归档的行不标 ★（P1/P2 有意不放它们，标 ★ 会造成"工作清单外的新增"假象）
        star: (t.isNew && t.inWindow !== false && !t.archived) ? '★' : '',
        _isNewRaw: !!t.isNew,             // 原始新增（不看窗口）→ 概览统计"新增但已过窗口"
        firstSeen: t.first_seen || '',
        windowState: t.archived ? '已归档' : (t.inWindow === false ? '已过窗口' : '窗口内'),
        _sponsorCount: api.sponsorCount,
        _trialCount: api.trialCount,
        _apis: [{ cn: api.name_cn || api.name_en, cat: api.potency_category }]
      });
    });
  });

  // ── 合并同一试验的重复行 ──
  const merged = new Map();
  for (const r of raw) {
    const cur = merged.get(r.key);
    if (!cur) { merged.set(r.key, r); continue; }
    cur._apis.push(...r._apis);
    cur._sponsorCount = Math.max(cur._sponsorCount, r._sponsorCount);
    cur._trialCount = Math.max(cur._trialCount, r._trialCount);
    if (r.drugName.length > cur.drugName.length) cur.drugName = r.drugName;
    if (r.star) cur.star = '★';
    if (r._isNewRaw) cur._isNewRaw = true;
    if (r.firstSeen && (!cur.firstSeen || r.firstSeen < cur.firstSeen)) cur.firstSeen = r.firstSeen;
    if (cur.windowState !== '窗口内' && r.windowState === '窗口内') cur.windowState = '窗口内';
    // 药物分类 / 分类依据 / 注册分类 **必须成套取**（v4.2.0：只留 CDE 官方实锤，无证据留空）：
    // 同一试验命中多个 API 时各 API 证据可能不同，逐列独立取会产出矛盾组合。
    // 规则：按证据强度（产品级 > 品种级）挑一条子行，成套搬运这 3 个字段。
    const BASIS_RANK = { 'CDE 受理数据（产品级）': 0, 'CDE 受理数据（品种级）': 1 };
    const rank = (r2) => {
      const b = BASIS_RANK[r2.classBasis] != null ? BASIS_RANK[r2.classBasis] : 3;
      return (r2.nmpaLevel === 'product' ? 0 : 10) + b;   // 产品级证据（精确命中试验产品）最强
    };
    if (rank(r) < rank(cur)) {
      cur.drugClass = r.drugClass; cur.classBasis = r.classBasis;
      cur.regClass = r.regClass; cur.nmpaLevel = r.nmpaLevel;
    }
    if (!cur.regClass && r.regClass) cur.regClass = r.regClass;
    // 剂型取能识别到的那个（不同 API 的提取结果可能不同）
    const curOk = cur.dosageForm && cur.dosageForm !== '未识别';
    const rOk = r.dosageForm && r.dosageForm !== '未识别';
    if (!curOk && rOk) cur.dosageForm = r.dosageForm;
    // 取最高风险等级：同时采用该 API 的推荐方案
    if (r.catNum < cur.catNum) {
      Object.assign(cur, { catNum: r.catNum, apiCn: r.apiCn, apiEn: r.apiEn, aiLimit: r.aiLimit, csp: r.csp, confirm: r.confirm });
    }
  }

  const rows = [...merged.values()].map(r => {
    const isOsd = isOralSolid(r.dosageForm);
    const seen = new Set();
    const related = r._apis
      .filter(a => { const k = a.cn; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => a.cat - b.cat || String(a.cn).localeCompare(String(b.cn)))
      .map(a => `${a.cn}(Cat${a.cat})`)
      .join(' / ');
    return {
      ...r,
      osd: isOsd,
      cat: `Cat ${r.catNum}`,
      priority: isOsd ? `P1-OSD-Cat${r.catNum}` : `P2-其他-Cat${r.catNum}`,
      relatedApis: related,
      dosageForm: r.dosageForm || '未识别'
    };
  });

  // ── 不变量自检（列间逻辑一致性）──
  // 目的：新增列时最容易被漏掉的"成套语义"问题，交给机器每次检查，别再靠人眼发现
  const violations = [];
  const ALLOWED_BASIS = new Set(['CDE 受理数据（产品级）', 'CDE 受理数据（品种级）', '']);
  for (const r of rows) {
    const basis = r.classBasis || '';
    const cls = r.drugClass || '';
    if (!ALLOWED_BASIS.has(basis)) violations.push([r.key, `分类依据取值非法（应为 CDE 受理数据产品级/品种级或空）: ${basis}`]);
    if (cls && !basis) violations.push([r.key, `药物分类「${cls}」却没有证据出处`]);
    if (!cls && basis) violations.push([r.key, `有证据出处「${basis}」却没有药物分类`]);
    // 注册分类 ↔ 药物分类 必须一致（只校验无歧义码）
    if (basis && r.regClass) {
      const code = String(r.regClass);
      const want = /^1(\.|$)/.test(code) ? '新药'
        : /^2/.test(code) ? '新药（改良型）'
          : /^(4|5\.2|3\.3|原6)$/.test(code) ? '仿制药'
            : /^5\.1$/.test(code) ? '原研药' : null;
      if (want && cls !== want) violations.push([r.key, `注册分类 ${code} 应配「${want}」但实为「${cls}」`]);
    }
    if (r.regClass && !basis) violations.push([r.key, `注册分类 ${r.regClass} 却没有证据出处`]);
  }

  // 排序：OSD 优先 → Cat 升序 → 段内企业数降序 → 进行中优先 → 登记日期降序
  rows.sort((a, b) => {
    if (a.osd !== b.osd) return a.osd ? -1 : 1;
    if (a.catNum !== b.catNum) return a.catNum - b.catNum;
    if (b._sponsorCount !== a._sponsorCount) return b._sponsorCount - a._sponsorCount;
    const aAct = ACTIVE_STATUS.test(a.status) ? 0 : 1;
    const bAct = ACTIVE_STATUS.test(b.status) ? 0 : 1;
    if (aAct !== bAct) return aAct - bAct;
    return String(b.regDate).localeCompare(String(a.regDate));
  });
  if (violations.length) {
    console.error(`⚠️ 分类/证据列一致性自检发现 ${violations.length} 处矛盾（前 5 条）：`);
    violations.slice(0, 5).forEach(([k, msg]) => console.error(`   - ${k}: ${msg}`));
    console.error('   → 请检查 report.js 的 classBasis 判定与合并规则是否同步');
  }
  rows.violations = violations;
  return rows;
}

// ── Markdown 渲染 ──
module.exports = { buildLeadModel, flattenTrials, ACTIVE_STATUS };
