/**
 * 亚硝胺场景专属 hooks（命令式逻辑）
 *
 * 这些函数逐字移植自重构前的报告生成逻辑，保证输出零回归。
 * 通用 report.js 通过约定接口调用它们；将来其他场景提供自己的 enrich.js。
 *
 * hooks：
 *   classifyTrial(trial)            → 药物分类（仿制药/原研药/新药/改良新药/观察性研究）
 *   recommendCSP(api, config)       → CSP 推荐方案：{ text, confirm }（以剂型为主，见下）
 *   newLeadSubtitle(api, config)     → 新增商机小标题行（> ...）
 *   fullLeadSubtitle(api, config)    → 全量商机小标题行（> ...）
 *   categoryHeader(cat, config)      → 风险分类标题（### ...）
 *   renderOverview(ctx)              → 概览整段（含剂型分布等场景专属统计）
 *   snapshotExtras(fda)              → 快照 fda_data 的场景专属字段
 */

// ── Known originator companies ──
const originatorCompanies = new Set([
  'Bayer', 'Novartis', 'Novartis Pharmaceuticals', 'Sanofi', 'AstraZeneca',
  'Pfizer', 'Eli Lilly', 'Eli Lilly and Company', 'Merck', 'MSD',
  'GlaxoSmithKline', 'Roche', 'AbbVie', 'Abbott', 'Johnson & Johnson',
  'Bristol-Myers Squibb', 'Amgen', 'Boehringer Ingelheim', 'Takeda',
  'Daiichi Sankyo', 'Otsuka', 'Eisai', 'Astellas', 'Gilead',
  'Biogen', 'Regeneron', 'Genentech', 'Vertex'
]);

// ── Drug classification inference ──
// ── Drug classification inference（规则基于真实 phase/trialType 取值）──
//   CDT: phase="其它 其他说明:生物等效性试验" | "I期/II期/III期"（trialType 含 生物等效/药代动力学/安全性和有效性）
//   CT.gov: phase="PHASE1/2/3/4" | "NA" | ""（trialType: INTERVENTIONAL / OBSERVATIONAL）
function classifyTrial(trial) {
  const phase = trial.phase || '';
  const trialType = trial.trialType || '';
  const sponsor = trial.sponsor || '';
  const drugName = trial.drugName || '';
  const title = `${trial.briefTitle || ''} ${trial.officialTitle || ''}`;
  const isOriginator = originatorCompanies.has(sponsor);

  // ── 仿制药：BE / 生物利用度 / 一致性评价 ──
  if (/生物等效|生物利用度|一致性评价|\bBE\b/i.test(trialType)) return '仿制药';
  if (/生物等效|一致性评价|bioequivalen/i.test(title)) return '仿制药';
  if (/生物等效|\bBE\b|其他-BE/.test(phase)) return '仿制药';

  // ── 观察性研究：非干预性，通常不是包装变更线索（显式标注，不留空） ──
  if (/OBSERVATIONAL/i.test(trialType)) return '观察性研究';

  // ── 改良型新药：剂型/复方改良特征 ──
  if (/缓释|控释|肠溶|迟释|缓控释|复方|口崩|分散片|咀嚼|双层|速释/.test(drugName)) return '新药（改良型）';

  const isLatePhase = /PHASE\s?(2|3|4)/.test(phase.toUpperCase()) || /^(II|III|IV)期/.test(phase);
  const isAnyPhase = /PHASE\s?(1|2|3|4)/.test(phase.toUpperCase()) || /^(I|II|III|IV)期/.test(phase);

  // ── 原研药：原研企业 + 中后期临床 ──
  if (isOriginator && isLatePhase) return '原研药';

  // ── 新药：干预性 I–III 期（非原研企业） ──
  if (isAnyPhase) return isOriginator ? '原研药' : '新药';

  // ── 其余（干预性但无分期 / 数据缺失）- 显式标为未分类 ──
  return '未分类';
}

// ── CSP 推荐方案：以剂型为主（CSP 选型第一准则是包装形态），风险等级只决定优先级 ──
// 返回 { text, confirm }：text=候选方案组合；confirm=需销售确认的信息（如“包装形态”）
function recommendCSP(api, config) {
  const map = config.csp_by_dosage_group || {};
  const entry = map[api.dosageGroup];
  if (entry && entry.candidates && entry.candidates.length > 0) {
    return { text: entry.candidates.join(' / '), confirm: entry.confirm || null };
  }
  // 兜底：剂型未知 → 回到按风险等级（历史行为）
  const byCat = (config.category.csp_by_category || {})[api.potency_category];
  return byCat ? { text: byCat, confirm: '剂型/包装形态' } : { text: '需评估', confirm: '剂型/包装形态' };
}

// ── Subtitle 片段：推荐方案 + 待确认项 ──
function cspPart(api) {
  if (!api.csp_recommendation) return '';
  let s = `推荐CSP方案: **${api.csp_recommendation}**`;
  if (api.csp_confirm) s += `（待确认: ${api.csp_confirm}）`;
  return s;
}

// ── 产品名归一（去空格/全角空格/标点 + 小写），用于跨 API、跨企业的同名产品归并 ──
function normalizeProductName(name) {
  return String(name || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[（）()\[\]【】"'“”·、；;,，]/g, '')
    .toLowerCase();
}

// ── 分类一致性修正（批量，通用层在逐试验分类后调用）──
// 背景：同一产品在不同试验里可能得到不同标签——例：同一企业的同品种，
//       BE 试验判为"仿制药"，而 IV 期（上市后）试验被判为"新药"，销售看到同药两种口径。
// 规则：① 同一产品名只要有一次 BE/一致性评价证据 → 该产品（非原研企业）统一为"仿制药"
//       ② 非原研企业的 IV 期试验 → "仿制药"（已上市产品，多数为仿制/已获批）
//       ③ 同一（企业, 产品）组内标签不一致时，按多数票 + 业务优先级统一
function refineClassifications(trials) {
  if (!trials || !trials.length) return;

  // ① 收集"有 BE 证据"的产品名
  const beProducts = new Set();
  for (const t of trials) {
    const beEvidence = t.drugClassification === '仿制药'
      || /生物等效|一致性评价|生物利用度/.test(`${t.trialType || ''} ${t.briefTitle || ''}`);
    if (beEvidence) beProducts.add(normalizeProductName(t.drugName));
  }

  // ①② 逐试验修正
  for (const t of trials) {
    if (originatorCompanies.has(t.sponsor || '')) continue;
    const key = normalizeProductName(t.drugName);
    const phase = String(t.phase || '');
    const isPhase4 = /^(IV|4)期/.test(phase) || /PHASE\s?4/i.test(phase);
    if (beProducts.has(key) || isPhase4) t.drugClassification = '仿制药';
  }

  // ③ （企业, 产品）组内统一
  const PRIORITY = ['仿制药', '新药（改良型）', '新药', '原研药', '观察性研究', '未分类'];
  const groups = new Map();
  for (const t of trials) {
    const g = `${t.sponsor || ''}|${normalizeProductName(t.drugName)}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }
  for (const list of groups.values()) {
    const counts = {};
    list.forEach(t => { const c = t.drugClassification || '未分类'; counts[c] = (counts[c] || 0) + 1; });
    if (Object.keys(counts).length <= 1) continue;
    const winner = Object.keys(counts).sort((a, b) =>
      counts[b] - counts[a] || PRIORITY.indexOf(a) - PRIORITY.indexOf(b))[0];
    list.forEach(t => { t.drugClassification = winner; });
  }
}

// ── New leads subtitle (the `> ...` line) ──
function newLeadSubtitle(api, config) {
  const labels = config.category.labels;
  let s = `> FDA风险等级: ${labels[api.potency_category]}(Cat ${api.potency_category}) | AI Limit: ${api.ai_limit} | ${cspPart(api)}`;
  if (api.oralSolidCount > 0) {
    s += ` | ⭐口服固体: ${api.oralSolidCount}条`;
  }
  return s;
}

// ── Full leads subtitle (the `> ...` line) ──
function fullLeadSubtitle(api, config) {
  let s = `> ${cspPart(api)}`;
  if (api.cdtSponsors.length > 0) {
    s += ` | CDT来源企业: ${api.cdtSponsors.length}家（含联系方式）`;
  }
  if (api.oralSolidCount > 0) {
    s += ` | ⭐口服固体: ${api.oralSolidCount}条`;
  }
  return s;
}

// ── Category section header ──
function categoryHeader(cat, config) {
  const labels = config.category.labels;
  // AI limit 分档（与重构前一致）：Cat1/2 → 26.5-100，Cat3 → 400，Cat4/5 → 1500
  const limitRange = cat <= 2 ? '26.5-100' : cat <= 3 ? '400' : '1500';
  return `### ${labels[cat]} (Cat ${cat}) — AI Limit: ${limitRange} ng/day`;
}

// ── Compute dosage form stats ──
// 输出：OSD（含改良释放）/ 其他剂型 / 未识别 三大类 + 细项
function computeFormStats(enrichedApis) {
  const detail = {};
  let osd = 0, other = 0, unknown = 0;
  for (const api of Object.values(enrichedApis)) {
    for (const t of api.trials) {
      const form = t.dosageForm;
      if (!form) { unknown++; detail['未识别'] = (detail['未识别'] || 0) + 1; continue; }
      detail[form] = (detail[form] || 0) + 1;
      if (/口服固体|改良释放/.test(form)) osd++;
      else other++;
    }
  }
  return { osd, other, unknown, detail };
}

// ── Overview section (scenario-specific presentation) ──
function renderOverview(ctx) {
  const { snap, config, totalLeads, totalNewLeads, apisWithLeadsCount, newLeadApisCount,
    byCat, allSponsorsGlobalSize, cdtCount, ctgovCount, cdtWithContact, ctgovWithContact,
    oralSolidCount, enrichedApis } = ctx;
  const labels = config.category.labels;

  let md = '## 概览\n\n';
  md += `- FDA亚硝胺风险API: **${snap.fda_data.total_apis}**个 → 中国有临床试验: **${apisWithLeadsCount}**个\n`;
  md += `- 新增（本次）: **${totalNewLeads}**条（来自 ${newLeadApisCount} 个API）\n`;
  const catStats = Object.entries(byCat).filter(([, apis]) => apis.length > 0)
    .map(([c, apis]) => `${labels[c]}(Cat ${c}): ${apis.length}个API`).join(' | ');
  md += `- 风险分布: ${catStats}\n`;
  md += `- 涉及企业/机构: **${allSponsorsGlobalSize}**家\n`;
  md += `- 数据源分布:\n`;
  md += `  - CDT ${cdtCount} 条（${cdtWithContact} 条含联系方式）\n`;
  md += `  - CT.gov ${ctgovCount} 条（${ctgovWithContact} 条含联系方式）\n`;
  md += `- **剂型分布**（优先级：OSD 优先）:\n`;
  const fs2 = computeFormStats(enrichedApis);
  md += `  - ⭐ **口服固体制剂(含改良释放): ${fs2.osd}条 (${(fs2.osd / totalLeads * 100).toFixed(1)}%)**\n`;
  md += `  - 其他剂型: ${fs2.other}条 (${(fs2.other / totalLeads * 100).toFixed(1)}%)\n`;
  md += `  - 未识别: ${fs2.unknown}条 (${(fs2.unknown / totalLeads * 100).toFixed(1)}%) — 多为观察性研究（药物仅作背景，无剂型意义）\n`;
  Object.entries(fs2.detail).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    .forEach(([form, count]) => { md += `    - ${form}: ${count}条\n`; });
  md += `\n`;
  return md;
}

// ── Snapshot fda_data extras ──
function snapshotExtras(fda) {
  return {
    api_count_with_nitrosamines: Object.values(fda.apis).filter(a => (a.nitrosamines || []).length > 0).length
  };
}

module.exports = {
  classifyTrial,
  refineClassifications,
  normalizeProductName,
  recommendCSP,
  newLeadSubtitle,
  fullLeadSubtitle,
  categoryHeader,
  renderOverview,
  snapshotExtras
};
