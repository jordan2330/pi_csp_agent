#!/usr/bin/env node
/**
 * CT.gov 数据富化器 v3
 * 
 * 重新拉取 CT.gov 数据，提取：
 * 1. 产品名称（从 Intervention.name 匹配 API 关键词）
 * 2. 剂型（从 Intervention.description + OfficialTitle 推断）
 * 3. 联系方式（centralContacts + Location.contacts）
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const WS = '/workspace';
const FDA_FILE = path.join(WS, 'config/fda_nitrosamines.json');
const ERR_LOG = path.join(WS, 'output/runs/errors.log');
const CTGOV_DELAY_MS = 800;

let fda;
const today = new Date();
const cutoff = new Date(today);
cutoff.setFullYear(cutoff.getFullYear() - 2);

function load() { fda = JSON.parse(fs.readFileSync(FDA_FILE, 'utf8')); }
function save() { fs.writeFileSync(FDA_FILE, JSON.stringify(fda, null, 2)); }
function ts() { return new Date().toISOString().slice(11, 19); }
function log(m) { console.error(`[${ts()}] ${m}`); }

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s.length === 7 ? s + '-01' : s);
  return isNaN(d) ? null : d;
}

function within2Yr(dateStr) {
  const d = parseDate(dateStr);
  return !d || d >= cutoff;
}

// ── CT.gov API fetch ──
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
  
  // Modified release (high-value signal)
  if (/extended[\s-]?release|sustained[\s-]?release|controlled[\s-]?release|delayed[\s-]?release|modified[\s-]?release/.test(t)) {
    return '改良释放制剂';
  }
  
  // Oral solids — CSP primary interest
  if (/\b(tablet|tab\b|caplet|pill|lozenge)\b/.test(t)) return '口服固体制剂(片剂)';
  if (/\b(capsule|cap\b)\b/.test(t)) return '口服固体制剂(胶囊)';
  if (/\b(powder|granule|sachet)\b/.test(t) && /\boral\b/.test(t)) return '口服固体制剂(颗粒/散剂)';
  
  // Oral liquids
  if (/\boral\b/.test(t) && /\b(solution|suspension|syrup|liquid|drop|elixir)\b/.test(t)) return '口服液体制剂';
  if (/\bsyrup\b/.test(t)) return '口服液体制剂';
  
  // Generic oral
  if (/\boral\b/.test(t) && !/\b(inject|infus|iv\b|topical|cream|ointment|nasal|eye|ophthalm)\b/.test(t)) return '口服制剂';
  
  // Inhalation
  if (/\b(dry\s*powder\s*inhal|dpi\b|metered[\s-]?dose\s*inhal|mdi\b|pressurized\s*inhal)\b/.test(t)) return '吸入制剂(粉末)';
  if (/\b(inhal|aerosol|nebuli|inhaler)\b/.test(t)) return '吸入制剂';
  
  // Injection
  if (/\b(inject|infus|iv\b|intraven|subcutan|sc\b|intramus|im\b)\b/.test(t)) return '注射制剂';
  
  // Topical / transdermal
  if (/\b(cream|ointment|gel\b|lotion|topical|patch|transdermal)\b/.test(t)) return '外用制剂';
  
  // Nasal (CSP secondary interest)
  if (/\b(nasal\s*spray|nasal\s*powder|intranasal)\b/.test(t)) return '鼻用制剂';
  if (/\b(nasal)\b/.test(t)) return '鼻用制剂';
  
  // Ophthalmic
  if (/\b(eye|ophthalm|ocular|eyedrop)\b/.test(t)) return '眼用制剂';
  
  // Suppository
  if (/\b(suppositor)\b/.test(t)) return '栓剂';
  
  return null;
}

// ── Extract product name from interventions ──
function extractProductName(interventions, apiName) {
  const drugs = interventions.filter(iv => iv.type === 'DRUG');
  if (drugs.length === 0) return '';
  
  const apiLower = apiName.toLowerCase();
  
  // Strategy 1: Find intervention whose name matches the API name
  const exactMatch = drugs.find(iv => {
    const name = (iv.name || '').toLowerCase();
    return name.includes(apiLower) || apiLower.includes(name.replace(/[\s-]/g, ''));
  });
  if (exactMatch) return exactMatch.name;
  
  // Strategy 2: Find intervention whose name OR description mentions API name
  const fuzzyMatch = drugs.find(iv => {
    const text = ((iv.name || '') + ' ' + (iv.description || '')).toLowerCase();
    return text.includes(apiLower);
  });
  if (fuzzyMatch) return fuzzyMatch.name;
  
  // Strategy 3: If only 1 drug intervention, use it
  if (drugs.length === 1) return drugs[0].name || '';
  
  // Strategy 4: Return first drug name
  return drugs[0].name || '';
}

// ── Extract dosage form from all available text ──
function extractDosageForm(interventions, briefTitle, officialTitle) {
  const allTexts = [];
  
  // Scan all drug interventions
  interventions.filter(iv => iv.type === 'DRUG').forEach(iv => {
    if (iv.name) allTexts.push(iv.name);
    if (iv.description) allTexts.push(iv.description);
  });
  
  // Also scan titles (often more descriptive)
  if (officialTitle) allTexts.push(officialTitle);
  if (briefTitle) allTexts.push(briefTitle);
  
  const combined = allTexts.join(' ');
  
  // Try detection
  const form = detectDosageFormEn(combined);
  if (form) return form;
  
  // Fallback: if "oral" appears anywhere without specific form
  if (/\boral\b/i.test(combined)) return '口服制剂';
  
  return null;
}

// ── Main transform ──
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
    const dosageForm = extractDosageForm(
      interventions,
      id.briefTitle || '',
      id.officialTitle || ''
    );

    // ── Contacts ──
    const centralContacts = clm.centralContacts || [];
    const centralContact = centralContacts.find(c => c.role === 'CONTACT') || centralContacts[0] || {};

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

// ── Main ──
async function main() {
  load();
  const t0 = Date.now();

  // Reset CT.gov state
  let resetCount = 0;
  Object.values(fda.apis).forEach(api => {
    api.searched_ctgov = false;
    api.searched_ctgov_date = null;
    // Keep CDT results, remove old CT.gov
    api.results = (api.results || []).filter(r => r.source === 'CDT');
    api.lead_count = api.results.length;
    resetCount++;
  });
  save();
  log(`已重置 ${resetCount} 个 API 的 CT.gov 状态（保留 CDT 数据）`);

  const toSearch = Object.entries(fda.apis)
    .filter(([, a]) => !a.searched_ctgov)
    .map(([n]) => n);

  log(`═══ CT.gov 富化扫描 ═══`);
  log(`待搜索: ${toSearch.length} 个API`);
  log(`日期过滤: >= ${cutoff.toISOString().slice(0, 10)} (2年)`);

  let done = 0, totalStudies = 0, withContact = 0, withDrugName = 0, withForm = 0, errors = 0;

  for (let i = 0; i < toSearch.length; i++) {
    const name = toSearch[i];
    const api = fda.apis[name];

    try {
      const result = await ctgovFetch(name);
      const allTrials = ctgovToTrials(result, name);
      const filtered = allTrials.filter(t => within2Yr(t.regDate));

      const existingCDT = (api.results || []).filter(r => r.source === 'CDT');
      api.results = existingCDT.concat(filtered);
      api.searched_ctgov = true;
      api.searched_ctgov_date = today.toISOString().slice(0, 10);
      api.lead_count = api.results.length;
      totalStudies += filtered.length;
      withContact += filtered.filter(t => t.contactPhone || t.contactEmail).length;
      withDrugName += filtered.filter(t => t.drugName).length;
      withForm += filtered.filter(t => t.dosageForm).length;

      if (filtered.length > 0 || i % 25 === 0) {
        const dn = filtered.filter(t => t.drugName).length;
        const df = filtered.filter(t => t.dosageForm).length;
        const ct = filtered.filter(t => t.contactPhone || t.contactEmail).length;
        log(`  [${i+1}] ${name}: ${result.totalCount}→${filtered.length} [产品名:${dn} 剂型:${df} 联系:${ct}]`);
      }
    } catch (e) {
      api.searched_ctgov = true;
      api.searched_ctgov_date = today.toISOString().slice(0, 10);
      fs.appendFileSync(ERR_LOG, `[${new Date().toISOString()}] [CT.gov-enrich] ${name}: ${e.message.substring(0, 200)}\n`);
      errors++;
      if (errors <= 5) log(`  ✗ ${name}: ${e.message.substring(0, 100)}`);
    }

    done++;
    if (done % 25 === 0) {
      save();
      log(`  ── 进度: ${done}/${toSearch.length}, ${totalStudies} studies ──`);
      log(`     产品名: ${withDrugName}, 剂型: ${withForm}, 联系方式: ${withContact}, 错误: ${errors}`);
    }

    await new Promise(r => setTimeout(r, CTGOV_DELAY_MS));
  }

  save();
  const mins = ((Date.now() - t0) / 60000).toFixed(1);

  log('');
  log('══════════════════════════════════════');
  log(`CT.gov 富化完成! 耗时: ${mins} 分钟`);
  log(`搜索: ${done} APIs, ${totalStudies} studies`);
  log(`产品名提取: ${withDrugName}/${totalStudies} (${(withDrugName/Math.max(totalStudies,1)*100).toFixed(1)}%)`);
  log(`剂型推断:   ${withForm}/${totalStudies} (${(withForm/Math.max(totalStudies,1)*100).toFixed(1)}%)`);
  log(`联系方式:   ${withContact}/${totalStudies} (${(withContact/Math.max(totalStudies,1)*100).toFixed(1)}%)`);
  log(`错误: ${errors}`);
  log('══════════════════════════════════════');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
