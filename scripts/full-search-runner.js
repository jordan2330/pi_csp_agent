#!/usr/bin/env node
/**
 * 全量搜索执行器 v2
 *
 * Phase 1: CT.gov REST API 搜索（251 API，~10分钟）
 * Phase 2: chinadrugtrials 搜索（cdt-search.js，~3小时）
 *
 * 断点续传：每个 API 完成后立即写入 fda_nitrosamines.json
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const WS = '/workspace';
const FDA_FILE = path.join(WS, 'config/fda_nitrosamines.json');
const ERR_LOG = path.join(WS, 'output/runs/errors.log');
const CDT_JS = path.join(WS, 'skills/browser_executor/scripts/cdt-search.js');

// ── Config ──
const CDT_MAX_DETAILS = 20;
const CDT_MAX_PAGES = 5;
const CTGOV_DELAY_MS = 800;   // polite delay between API calls
const CDT_DELAY_MS = 1200;    // delay between CDT searches

// ── State ──
let fda;
const today = new Date();
const cutoff = new Date(today);
cutoff.setFullYear(cutoff.getFullYear() - 2);
const CUTOFF_STR = cutoff.toISOString().slice(0, 10);

// ── Helpers ──
function load() { fda = JSON.parse(fs.readFileSync(FDA_FILE, 'utf8')); }
function save() { fs.writeFileSync(FDA_FILE, JSON.stringify(fda, null, 2)); }

function ts() { return new Date().toISOString().slice(11, 19); }
function log(m) { console.error(`[${ts()}] ${m}`); }
function errLog(api, src, msg) {
  fs.appendFileSync(ERR_LOG, `[${new Date().toISOString()}] [${src}] ${api}: ${msg}\n`);
}

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s.length === 7 ? s + '-01' : s);
  return isNaN(d) ? null : d;
}

function within2Yr(dateStr) {
  const d = parseDate(dateStr);
  return !d || d >= cutoff; // keep if no date or within 2 years
}

// ── CT.gov REST API ──
function ctgovFetch(apiName) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      'query.term': apiName,
      'query.locn': 'China',
      'countTotal': 'true',
      'pageSize': '1000',
      'fields': 'NCTId,BriefTitle,OfficialTitle,OverallStatus,Phase,StartDate,Condition,LeadSponsor,Location,CentralContact,Intervention'
    });
    const url = 'https://clinicaltrials.gov/api/v2/studies?' + params.toString();
    const req = https.get(url, { timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Dosage form detection (English) ──
function detectDosageFormEn(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/extended[\s-]?release|sustained[\s-]?release|controlled[\s-]?release|delayed[\s-]?release|modified[\s-]?release/.test(t)) return '改良释放制剂';
  if (/\b(tablet|tab\b|caplet|pill|lozenge)\b/.test(t)) return '口服固体制剂(片剂)';
  if (/\b(capsule|cap\b)\b/.test(t)) return '口服固体制剂(胶囊)';
  if (/\b(powder|granule|sachet)\b/.test(t) && /\boral\b/.test(t)) return '口服固体制剂(颗粒/散剂)';
  if (/\boral\b/.test(t) && /\b(solution|suspension|syrup|liquid|drop|elixir)\b/.test(t)) return '口服液体制剂';
  if (/\bsyrup\b/.test(t)) return '口服液体制剂';
  if (/\boral\b/.test(t) && !/\b(inject|infus|iv\b|topical|cream|ointment|nasal|eye|ophthalm)\b/.test(t)) return '口服制剂';
  if (/\b(dry\s*powder\s*inhal|dpi\b|metered[\s-]?dose\s*inhal|mdi\b|pressurized\s*inhal)\b/.test(t)) return '吸入制剂(粉末)';
  if (/\b(inhal|aerosol|nebuli|inhaler)\b/.test(t)) return '吸入制剂';
  if (/\b(inject|infus|iv\b|intraven|subcutan|sc\b|intramus|im\b)\b/.test(t)) return '注射制剂';
  if (/\b(cream|ointment|gel\b|lotion|topical|patch|transdermal)\b/.test(t)) return '外用制剂';
  if (/\b(nasal\s*spray|nasal\s*powder|intranasal)\b/.test(t)) return '鼻用制剂';
  if (/\b(nasal)\b/.test(t)) return '鼻用制剂';
  if (/\b(eye|ophthalm|ocular|eyedrop)\b/.test(t)) return '眼用制剂';
  if (/\b(suppositor)\b/.test(t)) return '栓剂';
  return null;
}

// ── Extract product name from interventions ──
function extractProductName(interventions, apiName) {
  const drugs = interventions.filter(iv => iv.type === 'DRUG');
  if (drugs.length === 0) return '';
  const apiLower = apiName.toLowerCase();
  const exactMatch = drugs.find(iv => {
    const name = (iv.name || '').toLowerCase();
    return name.includes(apiLower) || apiLower.includes(name.replace(/[\s-]/g, ''));
  });
  if (exactMatch) return exactMatch.name;
  const fuzzyMatch = drugs.find(iv => {
    const text = ((iv.name || '') + ' ' + (iv.description || '')).toLowerCase();
    return text.includes(apiLower);
  });
  if (fuzzyMatch) return fuzzyMatch.name;
  if (drugs.length === 1) return drugs[0].name || '';
  return drugs[0].name || '';
}

// ── Extract dosage form ──
function extractDosageForm(interventions, briefTitle, officialTitle) {
  const allTexts = [];
  interventions.filter(iv => iv.type === 'DRUG').forEach(iv => {
    if (iv.name) allTexts.push(iv.name);
    if (iv.description) allTexts.push(iv.description);
  });
  if (officialTitle) allTexts.push(officialTitle);
  if (briefTitle) allTexts.push(briefTitle);
  const combined = allTexts.join(' ');
  const form = detectDosageFormEn(combined);
  if (form) return form;
  if (/\boral\b/i.test(combined)) return '口服制剂';
  return null;
}

function ctgovToTrials(apiResult, apiName) {
  return (apiResult.studies || []).map(s => {
    const p = s.protocolSection || {};
    const id = p.identificationModule || {};
    const status = p.statusModule || {};
    const design = p.designModule || {};
    const sponsor = p.sponsorCollaboratorsModule || {};
    const clm = p.contactsLocationsModule || {};
    const interventions = (p.armsInterventionsModule || {}).interventions || [];
    const locs = clm.locations || [];
    const chinaLocs = locs.filter(l => (l.country || '').toLowerCase().includes('china'));

    // ── Product name ──
    const drugName = extractProductName(interventions, apiName);
    // ── Dosage form ──
    const dosageForm = extractDosageForm(interventions, id.briefTitle || '', id.officialTitle || '');

    // ── Central contacts (study-level) ──
    const centralContacts = clm.centralContacts || [];
    const centralContact = centralContacts.find(c => c.role === 'CONTACT') || centralContacts[0] || {};

    // ── Extract per-site contacts from China locations ──
    const siteContacts = [];
    chinaLocs.forEach(loc => {
      const contacts = loc.contacts || [];
      const primary = contacts.find(c => c.role === 'CONTACT') || contacts[0] || {};
      if (primary.name || primary.phone || primary.email) {
        siteContacts.push({
          facility: loc.facility || '',
          city: loc.city || '',
          contactName: primary.name || '',
          contactPhone: primary.phone || '',
          contactEmail: primary.email || ''
        });
      }
    });

    // Pick best contact: prefer first site contact with details, fallback to central
    const bestSite = siteContacts.find(sc => sc.contactPhone || sc.contactEmail);
    const contactName = (bestSite && bestSite.contactName) || centralContact.name || '';
    const contactPhone = (bestSite && bestSite.contactPhone) || centralContact.phone || '';
    const contactEmail = (bestSite && bestSite.contactEmail) || centralContact.email || '';

    // ── Conditions ──
    const conditions = (p.conditionsModule || {}).conditions || [];
    const condStr = conditions.map(c => typeof c === 'string' ? c : (c.name || '')).filter(Boolean).join('; ');

    return {
      regNo: id.nctId || '',
      source: 'CT.gov',
      sponsor: (sponsor.leadSponsor || {}).name || '',
      drugName,
      dosageForm,
      drugClassification: null,
      status: status.overallStatus || '',
      phase: (design.phases || []).join('/') || '',
      indication: condStr || id.briefTitle || '',
      regDate: status.startDateStruct?.date || '',
      contactName,
      contactPhone,
      contactEmail,
      contactAddress: '',
      centralContactName: centralContact.name || '',
      centralContactPhone: centralContact.phone || '',
      centralContactEmail: centralContact.email || '',
      siteContacts,
      chinaLocations: chinaLocs.map(l => ({ facility: l.facility || '', city: l.city || '' }))
    };
  });
}

// ── Phase 1: CT.gov ──
async function phase1() {
  log('═══ Phase 1: CT.gov REST API ═══');
  const toSearch = Object.entries(fda.apis)
    .filter(([, a]) => !a.searched_ctgov)
    .map(([n]) => n);
  log(`待搜索: ${toSearch.length} 个`);
  if (toSearch.length === 0) return { done: 0, total: 0 };

  let done = 0, totalStudies = 0, errors = 0;

  for (let i = 0; i < toSearch.length; i++) {
    const name = toSearch[i];
    const api = fda.apis[name];

    try {
      const result = await ctgovFetch(name);
      const allTrials = ctgovToTrials(result, name);
      const filtered = allTrials.filter(t => within2Yr(t.regDate));

      api.results = (api.results || []).concat(filtered);
      api.searched_ctgov = true;
      api.searched_ctgov_date = today.toISOString().slice(0, 10);
      api.lead_count = (api.results || []).length;
      totalStudies += filtered.length;

      if (filtered.length > 0 || i % 20 === 0) {
        log(`  ✓ ${name}: ${result.totalCount}→${filtered.length} (2yr)`);
      }
    } catch (e) {
      api.searched_ctgov = true;
      api.searched_ctgov_date = today.toISOString().slice(0, 10);
      errLog(name, 'CT.gov', e.message.substring(0, 200));
      errors++;
      if (errors <= 5) log(`  ✗ ${name}: ${e.message.substring(0, 100)}`);
    }

    done++;
    if (done % 25 === 0) {
      save();
      log(`  ── 进度: ${done}/${toSearch.length}, ${totalStudies} studies, ${errors} err ──`);
    }

    // Polite delay
    await new Promise(r => setTimeout(r, CTGOV_DELAY_MS));
  }

  save();
  log(`Phase 1 完成: ${done} APIs, ${totalStudies} studies, ${errors} errors`);
  return { done, total: totalStudies, errors };
}

// ── Phase 2: CDT ──
function phase2() {
  log('═══ Phase 2: chinadrugtrials ═══');
  const toSearch = Object.entries(fda.apis)
    .filter(([, a]) => !a.searched_cdt && a.name_cn)
    .map(([n, a]) => ({ name: n, name_cn: a.name_cn }));
  const noName = Object.entries(fda.apis)
    .filter(([, a]) => !a.searched_cdt && !a.name_cn);

  log(`待搜索: ${toSearch.length} 个 (无中文名跳过: ${noName.length})`);

  // Mark no-name APIs as done
  noName.forEach(([n]) => {
    fda.apis[n].searched_cdt = true;
    fda.apis[n].searched_cdt_date = today.toISOString().slice(0, 10);
  });
  if (noName.length) save();

  let done = 0, totalTrials = 0, errors = 0;
  const outFile = '/tmp/cdt-result.json';

  for (const { name, name_cn } of toSearch) {
    const api = fda.apis[name];
    if (api.searched_cdt) { done++; continue; } // resume support

    log(`[${done + 1}/${toSearch.length}] ${name_cn} (${name})...`);

    try {
      execSync(
        `node ${CDT_JS} "${name_cn}" ${outFile} --max-details ${CDT_MAX_DETAILS} --max-pages ${CDT_MAX_PAGES}`,
        { timeout: 180000, maxBuffer: 50 * 1024 * 1024, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );

      if (fs.existsSync(outFile)) {
        const cdt = JSON.parse(fs.readFileSync(outFile, 'utf8'));
        const trials = (cdt.detailedTrials || []).map(t => ({
          regNo: t.regNo || '',
          source: 'CDT',
          sponsor: t.applicantName || t.applicantCount || '',
          drugName: t.drugName || t.searchDrugName || '',
          drugType: t.drugType || '',
          drugClassification: null,
          status: t.trialStatus || t.searchStatus || '',
          phase: t.trialPhase || '',
          indication: t.indication || t.searchIndication || '',
          regDate: t.firstPostDate || '',
          contactName: t.contactName || '',
          contactPhone: t.contactPhone || '',
          contactEmail: t.contactEmail || '',
          contactAddress: t.contactAddress || '',
          piName: t.piName || '',
          piTitle: t.piTitle || '',
          piUnit: t.piUnit || '',
          sites: t.sites || [],
          ethicsDate: t.ethicsDate || '',
          targetEnrollment: t.targetEnrollment || ''
        }));

        const filtered = trials.filter(t => within2Yr(t.regDate));
        api.results = (api.results || []).concat(filtered);
        totalTrials += filtered.length;
        log(`  ✓ CDT: ${cdt.totalResults || 0}条 → ${filtered.length} (2yr)`);
      }
    } catch (e) {
      errLog(name, 'CDT', e.message.split('\n')[0].substring(0, 200));
      log(`  ✗ ${name_cn}: ${e.message.split('\n')[0].substring(0, 80)}`);
      errors++;
    }

    api.searched_cdt = true;
    api.searched_cdt_date = today.toISOString().slice(0, 10);
    api.lead_count = (api.results || []).length;
    done++;
    save();

    // Rate limit
    if (done % 10 === 0) {
      log(`  ── 进度: ${done}/${toSearch.length}, ${totalTrials} trials, ${errors} err ──`);
      execSync('sleep 2');
    } else {
      execSync('sleep 1');
    }
  }

  log(`Phase 2 完成: ${done} APIs, ${totalTrials} trials, ${errors} errors`);
  return { done, total: totalTrials, errors };
}

// ── Main ──
async function main() {
  load();
  const t0 = Date.now();

  // Verify full mode
  const cfg = JSON.parse(fs.readFileSync(path.join(WS, 'config/search-config.json'), 'utf8'));
  if (cfg.search_mode !== 'full') {
    log('search_mode != "full". Set config/search-config.json to "full" first.');
    process.exit(1);
  }

  // Reset
  log('═══ 重置搜索状态 ═══');
  let rc = 0, rd = 0;
  Object.values(fda.apis).forEach(api => {
    if (api.searched_cdt) { api.searched_cdt = false; api.searched_cdt_date = null; rc++; }
    if (api.searched_ctgov) { api.searched_ctgov = false; api.searched_ctgov_date = null; rd++; }
    api.results = [];
    api.lead_count = 0;
  });
  save();
  log(`已重置: CDT ${rc}, CT.gov ${rd}`);
  log(`日期过滤: >= ${CUTOFF_STR} (2年)`);

  // Phase 1: CT.gov (fast, ~10 min)
  const p1 = await phase1();

  // Phase 2: CDT (slow, ~3 hours)
  const p2 = phase2();

  // Summary
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  const all = Object.values(fda.apis);
  const bothDone = all.filter(a => a.searched_cdt && a.searched_ctgov).length;
  const withLeads = all.filter(a => (a.results || []).length > 0).length;
  const totalResults = all.reduce((s, a) => s + (a.results || []).length, 0);

  log('');
  log('══════════════════════════════════════');
  log(`全量搜索完成! 耗时: ${mins} 分钟`);
  log(`CT.gov: ${p1.done} APIs, ${p1.total} studies (${p1.errors} errors)`);
  log(`CDT:    ${p2.done} APIs, ${p2.total} trials (${p2.errors} errors)`);
  log(`合计: ${totalResults} 条商机, ${withLeads} 个API有商机`);
  log(`双源完成率: ${bothDone}/${all.length}`);
  log('══════════════════════════════════════');

  // Revert to incremental
  cfg.search_mode = 'incremental';
  fs.writeFileSync(path.join(WS, 'config/search-config.json'), JSON.stringify(cfg, null, 2));
  log('已自动切换为 incremental 模式');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
