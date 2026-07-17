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
const { resolveDosageForm, isOralSolid, isEnterprise } = require('./enrichment');

const WS = '/workspace';

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
function renderCell(col, t) {
  if (col.key === 'contact') return formatContact(t);
  if (col.key === 'dosageForm') return formBadge(t.dosageForm);
  if (col.key === 'isNew') return t.isNew ? '🆕' : '';
  let v = t[col.key];
  // Truncate indication and phase (user requirement)
  if (col.fmt && col.fmt.startsWith('truncate')) {
    return truncate(v, parseInt(col.fmt.slice(8), 10));
  }
  return (v === undefined || v === null || v === '') ? '-' : String(v);
}

function renderTable(columns, trials) {
  let t = '';
  t += '| ' + columns.map(c => c.header).join(' | ') + ' |\n';
  t += '|' + columns.map(c => '-'.repeat(Math.max((c.header || '').length, 3))).join('|') + '|\n';
  for (const tr of trials) {
    t += '| ' + columns.map(c => renderCell(c, tr)).join(' | ') + ' |\n';
  }
  return t;
}

function heading(api, tpl, config) {
  return tpl
    .replace('{name_cn}', api.name_cn)
    .replace('{name_en}', api.name_en)
    .replace('{sponsorCount}', api.sponsorCount)
    .replace('{trialCount}', api.trialCount);
}

// ── Main ──
function generateReport(snapshot, scenario, isFull) {
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

  // ── Date filter (2 years) ──
  const todayDate = new Date(today);
  const twoYearsAgo = new Date(todayDate);
  twoYearsAgo.setFullYear(todayDate.getFullYear() - 2);

  const filteredResults = {};
  Object.entries(results).forEach(([apiName, trials]) => {
    filteredResults[apiName] = (trials || []).filter(t => {
      const regDate = parseDate(t.regDate);
      return !regDate || regDate >= twoYearsAgo;
    });
  });
  const apisWithLeads = Object.keys(filteredResults).filter(k => (filteredResults[k] || []).length > 0);

  // ── Enrich + aggregate ──
  const enrichedApis = {};
  let totalLeads = 0;
  let totalNewLeads = 0;

  apisWithLeads.forEach(apiName => {
    const rawTrials = (filteredResults[apiName] || []).map(t => ({
      ...t,
      drugClassification: t.drugClassification || (hooks.classifyTrial ? hooks.classifyTrial(t) : null),
      dosageForm: resolveDosageForm(t),
      indication: t.indication || (t.source === 'CDT' ? t.briefTitle : (t.condition || t.briefTitle)) || '',
      phase: t.phase || ''
    }));

    // Enterprise filter: CDT trials are all pharma companies; CT.gov needs filtering
    const trials = rawTrials.filter(t => t.source === 'CDT' || isEnterprise(t.sponsor));
    if (trials.length === 0) return; // Skip API if no enterprise trials remain

    const info = apiInfo[apiName] || { name_cn: apiTranslations[apiName] || apiName, potency_category: 5, ai_limit: '1500 ng/day' };
    const newTrials = trials.filter(t => t.isNew);
    totalLeads += trials.length;
    totalNewLeads += newTrials.length;

    const cdtTrials = trials.filter(t => t.source === 'CDT');
    const ctgovTrials = trials.filter(t => t.source !== 'CDT');
    const cdtSponsors = new Set(cdtTrials.map(t => t.sponsor).filter(Boolean));
    const allSponsors = new Set(trials.map(t => t.sponsor).filter(Boolean));

    const partialApi = { potency_category: info.potency_category };
    enrichedApis[apiName] = {
      name_en: apiName,
      name_cn: info.name_cn,
      potency_category: info.potency_category,
      ai_limit: info.ai_limit,
      csp_recommendation: hooks.recommendCSP ? hooks.recommendCSP(partialApi, config) : (config.category.csp_by_category[info.potency_category] || null),
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
    snap: snapshot, config, totalLeads, totalNewLeads,
    apisWithLeadsCount: apisWithLeads.length, newLeadApisCount: newLeadApis.length,
    byCat, enrichedApis, allSponsorsGlobalSize: allSponsorsGlobal.size,
    cdtCount, ctgovCount, cdtWithContact, ctgovWithContact, oralSolidCount
  };

  // ── Render Markdown ──
  let md = '';
  md += '# ' + config.title + '\n';
  const sourceLabel = config.source_label.replace('{version}', snapshot.fda_data[config.cache_version_field] || 'unknown');
  md += `> 生成日期: ${today} | 数据来源: ${sourceLabel}\n`;
  md += `> 本次新增: ${totalNewLeads} 条 | 总计: ${totalLeads} 条\n\n`;

  // Overview (scenario-specific)
  if (hooks.renderOverview) {
    md += hooks.renderOverview(ctx);
  }

  // New leads section
  if (newLeadApis.length > 0) {
    md += '## ' + config.headings.new_leads_section + '\n\n';
    newLeadApis.forEach(api => {
      md += '### ' + heading(api, config.headings.new_lead_api, config) + '\n';
      md += hooks.newLeadSubtitle(api, config) + '\n\n';
      md += renderTable(config.tables.new_leads.columns, sortTrialsCDTFirst(api.newTrials));
      md += '\n';
    });
  }

  // Full leads section: only in full mode (增量模式只输出新增商机，避免报告过大)
  if (isFull) {
    md += '## ' + config.headings.full_leads_section + '\n\n';
    config.category.order.filter(c => (byCat[c] || []).length > 0).forEach(cat => {
      md += hooks.categoryHeader(cat, config) + '\n\n';
      byCat[cat].forEach(api => {
        md += '#### ' + heading(api, config.headings.full_lead_api, config) + '\n';
        md += hooks.fullLeadSubtitle(api, config) + '\n\n';
        md += renderTable(config.tables.full_leads.columns, sortTrialsCDTFirst(api.trials));
        md += '\n';
      });
    });
  }

  // ── Write report ──
  const outputPath = path.join(WS, config.report_file);
  fs.writeFileSync(outputPath, md, 'utf8');
  return { outputPath, totalLeads, totalNewLeads, apisWithLeadsCount: apisWithLeads.length };
}

// ── Standalone (verification harness) ──
if (require.main === module) {
  const scenarioName = process.argv[2] || 'nitrosamine';
  const scenarioDir = path.join(WS, 'scenarios', scenarioName);
  const config = JSON.parse(fs.readFileSync(path.join(scenarioDir, 'scenario.json'), 'utf8'));
  const hooks = require(path.join(scenarioDir, 'enrich.js'));
  const todayStr = new Date().toISOString().slice(0, 10);
  const snapFile = path.join(WS, 'output/runs', todayStr + '.json');
  if (!fs.existsSync(snapFile)) {
    console.error('Snapshot not found:', snapFile);
    process.exit(1);
  }
  const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  // Read search mode to determine isFull
  let isFull = false;
  try {
    const searchConfig = JSON.parse(fs.readFileSync(path.join(WS, 'config/search-config.json'), 'utf8'));
    isFull = searchConfig.search_mode === 'full';
  } catch (_) {}
  const r = generateReport(snap, { config, hooks }, isFull);
  console.log('Report written:', r.outputPath);
  console.log(`Stats: ${r.totalLeads} leads, ${r.totalNewLeads} new, ${r.apisWithLeadsCount} APIs with leads`);
}

module.exports = { generateReport };
