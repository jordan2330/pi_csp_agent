#!/usr/bin/env node
/**
 * CSP 商机报告生成器 v4
 *
 * 改进：
 * 1. 药物分类推断（仿制药/原研药/新药/改良新药）
 * 2. 产品名称显示（drugName）—— 双源均支持
 * 3. 企业联系方式（contactName/Phone/Email/Address）—— 双源均支持
 * 4. **剂型列**（CDT drugName 后缀提取 + CT.gov Intervention 推断）
 * 5. 新增商机表去掉冗余的"推荐CSP方案"列（已在 API 标题行显示）
 * 6. CDT 来源（有联系方式）排前面，CT.gov 联系方式也展示
 * 7. 口服固体制剂高亮标注
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = '/workspace';

// ── Load data ──
const todayStr = new Date().toISOString().slice(0, 10);
const snapFile = process.argv[2] || path.join(WORKSPACE, 'output/runs/' + todayStr + '.json');
const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
const prevFile = process.argv[3];
let prevResults = {};
if (prevFile && fs.existsSync(prevFile)) {
  const prev = JSON.parse(fs.readFileSync(prevFile, 'utf8'));
  prevResults = prev.trials_data ? prev.trials_data.results : {};
}
const fdaCache = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'config/fda_nitrosamines.json'), 'utf8'));
const apiTranslations = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'config/api_translations.json'), 'utf8'));
const searchConfig = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'config/search-config.json'), 'utf8'));

const results = snap.trials_data.results;
const today = new Date().toISOString().slice(0, 10);

// ── CSP recommendation matrix ──
const cspRecommendations = {
  1: 'Activ-Blister®',
  2: 'Activ-Blister®',
  3: '3-Phase Activ-Polymer™',
  4: '3-Phase Activ-Polymer™ / Activ-Vial®',
  5: 'Activ-Vial® / Activ-Film®'
};
const riskLabels = { 1: '极高风险', 2: '高风险', 3: '中高风险', 4: '中风险', 5: '低风险' };

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
function classifyDrug(trial) {
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

// ── Dosage form extraction from CDT drugName (Chinese suffix) ──
function extractDosageFormCN(drugName) {
  if (!drugName) return null;
  const name = drugName.trim();

  // Modified release (highest priority signal)
  if (/缓释|控释|肠溶|迟释|长效/.test(name)) {
    if (/片/.test(name)) return '改良释放制剂(片剂)';
    if (/胶囊/.test(name)) return '改良释放制剂(胶囊)';
    if (/颗粒/.test(name)) return '改良释放制剂(颗粒)';
    return '改良释放制剂';
  }

  // Oral solids — CSP primary interest
  // Match 片/胶囊 even with trailing parenthetical like （Ⅲ）（空腹）
  if (/片/.test(name) && !/注射|外用|吸入|滴眼|鼻喷|软膏|乳膏|凝胶|贴剂/.test(name)) return '口服固体制剂(片剂)';
  if (/胶囊/.test(name) && !/注射|外用|吸入|滴眼|鼻喷/.test(name)) return '口服固体制剂(胶囊)';
  if (/(颗粒|冲剂|散剂|粉剂|干混悬剂)/.test(name) && !/注射|外用|吸入|滴眼/.test(name)) return '口服固体制剂(颗粒/散剂)';
  if (/丸剂|滴丸|微丸/.test(name)) return '口服固体制剂(丸剂)';

  // Oral liquids
  if (/口服溶液|口服液|糖浆|混悬液|口服混悬|乳剂|酊剂/.test(name)) return '口服液体制剂';

  // Generic oral (catch-all for 口服 but not clearly solid/liquid)
  if (/口服/.test(name) && !/注射|外用|吸入|滴眼|鼻喷/.test(name)) return '口服制剂';

  // Inhalation (match broadly — 吸入/雾化吸入 anywhere in name)
  if (/吸入|雾化吸入|气雾剂|喷雾剂|粉雾剂|干粉吸入/.test(name)) {
    if (/粉雾|干粉|粉末/.test(name)) return '吸入制剂(粉末)';
    return '吸入制剂';
  }

  // Injection
  if (/注射液|注射用|注射剂|粉针|冻干粉针/.test(name)) return '注射制剂';

  // Nasal (CSP secondary interest)
  if (/鼻喷|鼻用|滴鼻|鼻腔/.test(name)) return '鼻用制剂';

  // Topical / transdermal
  if (/软膏|乳膏|凝胶|贴剂|贴片|搽剂|涂剂|外用溶液|外用/.test(name)) return '外用制剂';

  // Ophthalmic
  if (/滴眼液|眼用|眼膏|眼药水/.test(name)) return '眼用制剂';

  // Suppository
  if (/栓剂/.test(name)) return '栓剂';

  return null;
}

// ── Unified dosage form resolver ──
function resolveDosageForm(t) {
  // If already extracted during CT.gov fetch
  if (t.dosageForm) return t.dosageForm;
  // CDT: extract from Chinese drugName
  if (t.source === 'CDT') {
    return extractDosageFormCN(t.drugName);
  }
  return null;
}

// ── Is oral solid? (for highlighting) ──
function isOralSolid(form) {
  if (!form) return false;
  return /口服固体|改良释放|口服固体制剂/.test(form);
}

// ── Build API info ──
const apiInfo = {};
Object.entries(fdaCache.apis).forEach(([name, info]) => {
  apiInfo[name] = {
    name_cn: info.name_cn || apiTranslations[name] || name,
    potency_category: info.potency_category,
    ai_limit: info.ai_limit,
    nitrosamines: info.nitrosamines || []
  };
});

// ── Enrich trials ──
const enrichedApis = {};
let totalLeads = 0;
let totalNewLeads = 0;

const todayDate = new Date(today);
const twoYearsAgo = new Date(todayDate);
twoYearsAgo.setFullYear(todayDate.getFullYear() - 2);

function parseDate(d) {
  if (!d) return null;
  const normalized = d.length === 7 ? d + '-01' : d;
  const parsed = new Date(normalized);
  return isNaN(parsed.getTime()) ? null : parsed;
}

const filteredResults = {};
Object.entries(results).forEach(([apiName, trials]) => {
  filteredResults[apiName] = (trials || []).filter(t => {
    const regDate = parseDate(t.regDate);
    return !regDate || regDate >= twoYearsAgo;
  });
});

const apisWithLeads = Object.keys(filteredResults).filter(k => (filteredResults[k] || []).length > 0);

// Global dosage form stats
let formStats = { '口服固体制剂(片剂)': 0, '口服固体制剂(胶囊)': 0, '口服固体制剂(颗粒/散剂)': 0,
  '改良释放制剂': 0, '吸入制剂': 0, '注射制剂': 0, '口服液体制剂': 0, '外用制剂': 0,
  '鼻用制剂': 0, '其他': 0, '未识别': 0 };
let oralSolidCount = 0;

apisWithLeads.forEach(apiName => {
  const trials = (filteredResults[apiName] || []).map(t => ({
    ...t,
    drugClassification: t.drugClassification || classifyDrug(t),
    dosageForm: resolveDosageForm(t)
  }));

  const info = apiInfo[apiName] || { name_cn: apiTranslations[apiName] || apiName, potency_category: 5, ai_limit: '1500 ng/day' };
  const newTrials = trials.filter(t => t.isNew);
  totalLeads += trials.length;
  totalNewLeads += newTrials.length;

  // Dosage form stats
  trials.forEach(t => {
    const form = t.dosageForm;
    if (!form) { formStats['未识别']++; return; }
    if (isOralSolid(form)) oralSolidCount++;
    // Categorize
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
  });

  const cdtTrials = trials.filter(t => t.source === 'CDT');
  const ctgovTrials = trials.filter(t => t.source !== 'CDT');
  const cdtSponsors = new Set(cdtTrials.map(t => t.sponsor).filter(Boolean));
  const allSponsors = new Set(trials.map(t => t.sponsor).filter(Boolean));

  enrichedApis[apiName] = {
    name_en: apiName,
    name_cn: info.name_cn,
    potency_category: info.potency_category,
    ai_limit: info.ai_limit,
    csp_recommendation: cspRecommendations[info.potency_category],
    trials,
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

// ── Category grouping ──
const byCat = { 1: [], 2: [], 3: [], 4: [], 5: [] };
Object.values(enrichedApis).forEach(api => {
  const cat = api.potency_category;
  if (byCat[cat]) byCat[cat].push(api);
});
Object.values(byCat).forEach(apis => apis.sort((a, b) => b.trialCount - a.trialCount));

const newLeadApis = Object.values(enrichedApis)
  .filter(a => a.newTrialCount > 0)
  .sort((a, b) => b.newTrialCount - a.newTrialCount);

// ── Phase ordering ──
const phaseOrder = { 'III期': 0, 'IV期': 1, 'II期': 2, 'I期': 3, '其他-BE': 4, 'N/A': 5 };

function sortTrialsCDTFirst(trials) {
  return [...trials].sort((a, b) => {
    const aCDT = a.source === 'CDT' ? 0 : 1;
    const bCDT = b.source === 'CDT' ? 0 : 1;
    if (aCDT !== bCDT) return aCDT - bCDT;
    return (phaseOrder[a.phase] ?? 5) - (phaseOrder[b.phase] ?? 5);
  });
}

function truncate(s, max) {
  if (!s) return '-';
  return s.length > max ? s.substring(0, max - 1) + '…' : s;
}

function formatContact(t) {
  const parts = [];
  if (t.contactName) parts.push(t.contactName);
  if (t.contactPhone) parts.push(t.contactPhone);
  if (t.contactEmail) parts.push(t.contactEmail);
  return parts.length > 0 ? truncate(parts.join(' / '), 45) : '-';
}

function hasContact(t) {
  return !!(t.contactName || t.contactPhone || t.contactEmail);
}

function formBadge(form) {
  if (!form) return '-';
  if (isOralSolid(form)) return `**${form}**`;
  return form;
}

// ── Generate Markdown ──
let md = '';
md += '# CSP 商机发掘报告 — 亚硝胺\n';
md += `> 生成日期: ${today} | 数据来源: FDA (版本 ${snap.fda_data.fda_page_version}) + 中国药物临床试验登记与信息公示平台 + ClinicalTrials.gov\n`;
md += `> 本次新增: ${totalNewLeads} 条 | 总计: ${totalLeads} 条\n\n`;

// Overview
md += '## 概览\n\n';
md += `- FDA亚硝胺风险API: **${snap.fda_data.total_apis}**个 → 中国有临床试验: **${apisWithLeads.length}**个\n`;
md += `- 新增（本次）: **${totalNewLeads}**条（来自 ${newLeadApis.length} 个API）\n`;
const catStats = Object.entries(byCat).filter(([, apis]) => apis.length > 0)
  .map(([c, apis]) => `${riskLabels[c]}(Cat ${c}): ${apis.length}个API`).join(' | ');
md += `- 风险分布: ${catStats}\n`;

const allSponsorsGlobal = new Set();
Object.values(enrichedApis).forEach(a => a.allSponsors.forEach(s => allSponsorsGlobal.add(s)));
md += `- 涉及企业/机构: **${allSponsorsGlobal.size}**家\n`;

let cdtCount = 0, ctgovCount = 0, cdtWithContact = 0, ctgovWithContact = 0;
Object.values(enrichedApis).forEach(a => {
  cdtCount += a.cdtTrials.length;
  ctgovCount += a.ctgovTrials.length;
  cdtWithContact += a.cdtTrials.filter(hasContact).length;
  ctgovWithContact += a.ctgovTrials.filter(hasContact).length;
});
md += `- 数据源分布:\n`;
md += `  - CDT ${cdtCount} 条（${cdtWithContact} 条含联系方式）\n`;
md += `  - CT.gov ${ctgovCount} 条（${ctgovWithContact} 条含联系方式）\n`;

// Dosage form summary
md += `- **剂型分布**（CSP重点关注口服固体制剂）:\n`;
const totalIdentified = totalLeads - formStats['未识别'];
const formEntries = Object.entries(formStats)
  .filter(([, v]) => v > 0)
  .sort((a, b) => b[1] - a[1]);
formEntries.forEach(([form, count]) => {
  const pct = (count / totalLeads * 100).toFixed(1);
  const marker = form.includes('口服固体') || form === '改良释放制剂' ? ' ⭐' : '';
  md += `  - ${form}: **${count}**条 (${pct}%)${marker}\n`;
});
md += `  - 💊 **口服固体制剂合计: ${oralSolidCount}条 (${(oralSolidCount/totalLeads*100).toFixed(1)}%)**\n\n`;

// ── New leads section (without 推荐CSP方案 column — already in subtitle) ──
if (newLeadApis.length > 0) {
  md += '## 新增商机（本次）\n\n';
  newLeadApis.forEach(api => {
    md += `### ${api.name_cn} ${api.name_en} — ${api.sponsorCount}家企业\n`;
    md += `> FDA风险等级: ${riskLabels[api.potency_category]}(Cat ${api.potency_category}) | AI Limit: ${api.ai_limit} | 推荐CSP方案: **${api.csp_recommendation}**`;
    if (api.oralSolidCount > 0) {
      md += ` | ⭐口服固体: ${api.oralSolidCount}条`;
    }
    md += '\n\n';
    // Columns: no "推荐CSP方案" (shown above), added "剂型"
    md += '| 申请人 | 产品名称 | 剂型 | 药物分类 | 试验状态 | 适应症 | 试验分期 | 登记日期 | 联系方式 | 来源 |\n';
    md += '|--------|---------|------|---------|---------|--------|---------|---------|---------|------|\n';
    sortTrialsCDTFirst(api.newTrials).forEach(t => {
      const sponsor = truncate(t.sponsor, 25);
      const drugName = truncate(t.drugName || '-', 20);
      const dosageForm = formBadge(t.dosageForm);
      const drugClass = t.drugClassification || '-';
      const status = t.status || '-';
      const indication = truncate(t.indication, 25);
      const phase = t.phase || '-';
      const regDate = t.regDate || '-';
      const contact = formatContact(t);
      const source = t.source || '-';
      md += `| ${sponsor} | ${drugName} | ${dosageForm} | ${drugClass} | ${status} | ${indication} | ${phase} | ${regDate} | ${contact} | ${source} |\n`;
    });
    md += '\n';
  });
}

// ── Full leads section ──
md += '## 全量商机列表\n\n';
Object.entries(byCat).filter(([, apis]) => apis.length > 0).forEach(([cat, apis]) => {
  const limitRange = cat <= 2 ? '26.5-100' : cat <= 3 ? '400' : '1500';
  md += `### ${riskLabels[cat]} (Cat ${cat}) — AI Limit: ${limitRange} ng/day\n\n`;

  apis.forEach(api => {
    md += `#### ${api.name_cn} ${api.name_en} (${api.trialCount}条试验, ${api.sponsorCount}家企业)\n`;
    md += `> 推荐CSP方案: **${api.csp_recommendation}**`;
    if (api.cdtSponsors.length > 0) {
      md += ` | CDT来源企业: ${api.cdtSponsors.length}家（含联系方式）`;
    }
    if (api.oralSolidCount > 0) {
      md += ` | ⭐口服固体: ${api.oralSolidCount}条`;
    }
    md += '\n\n';

    // Full table with 剂型 column
    md += '| 申请人 | 产品名称 | 剂型 | 药物分类 | 联系人 | 电话 | 邮箱 | 地址 | 试验状态 | 适应症 | 分期 | 来源 | 新增 |\n';
    md += '|--------|---------|------|---------|-------|------|------|------|---------|--------|------|------|------|\n';

    sortTrialsCDTFirst(api.trials).forEach(t => {
      const sponsor = truncate(t.sponsor, 28);
      const drugName = truncate(t.drugName || '-', 18);
      const dosageForm = formBadge(t.dosageForm);
      const drugClass = t.drugClassification || '-';
      const contactName = t.contactName || '-';
      const phone = t.contactPhone || '-';
      const email = t.contactEmail || '-';
      const address = truncate(t.contactAddress, 20);
      const status = t.status || '-';
      const indication = truncate(t.indication, 28);
      const phase = t.phase || '-';
      const source = t.source || '-';
      const isNew = t.isNew ? '🆕' : '';
      md += `| ${sponsor} | ${drugName} | ${dosageForm} | ${drugClass} | ${contactName} | ${phone} | ${email} | ${address} | ${status} | ${indication} | ${phase} | ${source} | ${isNew} |\n`;
    });
    md += '\n';
  });
});

// ── Write report ──
const outputPath = path.join(WORKSPACE, 'output/CSP_Leads_Report.md');
fs.writeFileSync(outputPath, md, 'utf8');
console.log('Report generated:', outputPath);
console.log('Total lines:', md.split('\n').length);
console.log(`Stats: ${totalLeads} leads, ${totalNewLeads} new, ${apisWithLeads.length} APIs with leads`);
console.log(`CDT trials: ${cdtCount} (${cdtWithContact} with contact), CT.gov trials: ${ctgovCount} (${ctgovWithContact} with contact)`);
console.log(`Oral solid forms: ${oralSolidCount} (${(oralSolidCount/totalLeads*100).toFixed(1)}%)`);
console.log(`Form stats:`, JSON.stringify(formStats));
