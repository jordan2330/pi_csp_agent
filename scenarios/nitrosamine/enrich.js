/**
 * 亚硝胺场景专属 hooks（命令式逻辑）
 *
 * 这些函数逐字移植自重构前的报告生成逻辑，保证输出零回归。
 * 通用 report.js 通过约定接口调用它们；将来其他场景提供自己的 enrich.js。
 *
 * hooks：
 *   classifyTrial(trial)            → 药物分类（仿制药/原研药/新药/改良新药）
 *   recommendCSP(api, config)       → CSP 推荐方案（按 potency category 查表）
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
function classifyTrial(trial) {
  if (trial.phase === '其他-BE' || trial.phase === 'BE') return '仿制药';
  const sponsor = trial.sponsor || '';
  const isOriginator = originatorCompanies.has(sponsor);
  if (isOriginator && (trial.phase === 'III期' || trial.phase === 'IV期' ||
      trial.phase === 'PHASE3' || trial.phase === 'PHASE4')) {
    return '原研药';
  }
  if (trial.phase === 'I期' || trial.phase === 'PHASE1') {
    const drugName = trial.drugName || '';
    if (drugName.includes('缓释') || drugName.includes('控释') || drugName.includes('肠溶') ||
        drugName.includes('新规格') || drugName.includes('改良')) {
      return '新药（改良型）';
    }
    if (sponsor.includes('创新') || sponsor.includes('新药') || sponsor.includes('生物科技')) {
      return '新药';
    }
  }
  return null;
}

// ── CSP recommendation by potency category ──
function recommendCSP(api, config) {
  const csp = config.category.csp_by_category;
  return csp[api.potency_category] || null;
}

// ── New leads subtitle (the `> ...` line) ──
function newLeadSubtitle(api, config) {
  const labels = config.category.labels;
  let s = `> FDA风险等级: ${labels[api.potency_category]}(Cat ${api.potency_category}) | AI Limit: ${api.ai_limit} | 推荐CSP方案: **${api.csp_recommendation}**`;
  if (api.oralSolidCount > 0) {
    s += ` | ⭐口服固体: ${api.oralSolidCount}条`;
  }
  return s;
}

// ── Full leads subtitle (the `> ...` line) ──
function fullLeadSubtitle(api, config) {
  let s = `> 推荐CSP方案: **${api.csp_recommendation}**`;
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

// ── Compute dosage form stats (scenario-specific categories + markers) ──
function computeFormStats(enrichedApis) {
  const formStats = {
    '口服固体制剂(片剂)': 0, '口服固体制剂(胶囊)': 0, '口服固体制剂(颗粒/散剂)': 0,
    '改良释放制剂': 0, '吸入制剂': 0, '注射制剂': 0, '口服液体制剂': 0,
    '外用制剂': 0, '鼻用制剂': 0, '其他': 0, '未识别': 0
  };
  for (const api of Object.values(enrichedApis)) {
    for (const t of api.trials) {
      const form = t.dosageForm;
      if (!form) { formStats['未识别']++; continue; }
      if (form.startsWith('口服固体制剂(片剂)')) formStats['口服固体制剂(片剂)']++;
      else if (form.startsWith('口服固体制剂(胶囊)')) formStats['口服固体制剂(胶囊)']++;
      else if (form.startsWith('口服固体制剂(颗粒')) formStats['口服固体制剂(颗粒/散剂)']++;
      else if (form.startsWith('改良释放')) formStats['改良释放制剂']++;
      else if (form.startsWith('吸入')) formStats['吸入制剂']++;
      else if (form.startsWith('注射')) formStats['注射制剂']++;
      else if (form.startsWith('口服液')) formStats['口服液体制剂']++;
      else if (form.startsWith('外用')) formStats['外用制剂']++;
      else if (form.startsWith('鼻用')) formStats['鼻用制剂']++;
      else formStats['其他']++;
    }
  }
  return formStats;
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
  md += `- **剂型分布**（CSP重点关注口服固体制剂）:\n`;
  const formStats = computeFormStats(enrichedApis);
  const formEntries = Object.entries(formStats).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  formEntries.forEach(([form, count]) => {
    const pct = (count / totalLeads * 100).toFixed(1);
    const marker = form.includes('口服固体') || form === '改良释放制剂' ? ' ⭐' : '';
    md += `  - ${form}: **${count}**条 (${pct}%)${marker}\n`;
  });
  md += `  - 💊 **口服固体制剂合计: ${oralSolidCount}条 (${(oralSolidCount / totalLeads * 100).toFixed(1)}%)**\n\n`;
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
  recommendCSP,
  newLeadSubtitle,
  fullLeadSubtitle,
  categoryHeader,
  renderOverview,
  snapshotExtras
};
