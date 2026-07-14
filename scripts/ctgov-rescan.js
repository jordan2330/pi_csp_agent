#!/usr/bin/env node
/**
 * CT.gov 联系方式补扫器
 * 
 * 只重新搜索 CT.gov，不碰 CDT 数据。
 * 提取 centralContacts + location contacts（联系人、电话、邮箱）
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

function ctgovFetch(apiName) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      'query.term': apiName,
      'query.locn': 'China',
      'countTotal': 'true',
      'pageSize': '1000',
      'fields': 'NCTId,BriefTitle,OverallStatus,Phase,StartDate,Condition,LeadSponsor,Location,CentralContact'
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

function ctgovToTrials(apiResult) {
  return (apiResult.studies || []).map(s => {
    const p = s.protocolSection || {};
    const id = p.identificationModule || {};
    const status = p.statusModule || {};
    const design = p.designModule || {};
    const sponsor = p.sponsorCollaboratorsModule || {};
    const clm = p.contactsLocationsModule || {};
    const locs = clm.locations || [];
    const chinaLocs = locs.filter(l => (l.country || '').toLowerCase().includes('china'));

    // ── Central contacts (study-level) ──
    const centralContacts = clm.centralContacts || [];
    const centralContact = centralContacts.find(c => c.role === 'CONTACT') || centralContacts[0] || {};

    // ── Per-site contacts from China locations ──
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

    // Condition: try array of objects first, then array of strings
    const conditions = (p.conditionsModule || {}).conditions || [];
    const condStr = conditions.map(c => typeof c === 'string' ? c : (c.name || '')).filter(Boolean).join('; ');

    return {
      regNo: id.nctId || '',
      source: 'CT.gov',
      sponsor: (sponsor.leadSponsor || {}).name || '',
      drugName: '',
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

async function main() {
  load();
  const t0 = Date.now();

  const toSearch = Object.entries(fda.apis)
    .filter(([, a]) => !a.searched_ctgov)
    .map(([n]) => n);

  log(`═══ CT.gov 联系方式补扫 ═══`);
  log(`待搜索: ${toSearch.length} 个API`);

  if (toSearch.length === 0) {
    log('所有API已完成CT.gov搜索');
    return;
  }

  let done = 0, totalStudies = 0, withContact = 0, errors = 0;

  for (let i = 0; i < toSearch.length; i++) {
    const name = toSearch[i];
    const api = fda.apis[name];

    try {
      const result = await ctgovFetch(name);
      const allTrials = ctgovToTrials(result);
      const filtered = allTrials.filter(t => within2Yr(t.regDate));

      // Merge: keep existing CDT results, add new CT.gov results
      const existingCDT = (api.results || []).filter(r => r.source === 'CDT');
      api.results = existingCDT.concat(filtered);
      api.searched_ctgov = true;
      api.searched_ctgov_date = today.toISOString().slice(0, 10);
      api.lead_count = api.results.length;
      totalStudies += filtered.length;
      withContact += filtered.filter(t => t.contactPhone || t.contactEmail).length;

      if (filtered.length > 0 || i % 25 === 0) {
        const ctCount = filtered.filter(t => t.contactPhone || t.contactEmail).length;
        log(`  [${i+1}] ${name}: ${result.totalCount}→${filtered.length} (2yr) [${ctCount}有联系方式]`);
      }
    } catch (e) {
      api.searched_ctgov = true;
      api.searched_ctgov_date = today.toISOString().slice(0, 10);
      fs.appendFileSync(ERR_LOG, `[${new Date().toISOString()}] [CT.gov-rescan] ${name}: ${e.message.substring(0, 200)}\n`);
      errors++;
      if (errors <= 5) log(`  ✗ ${name}: ${e.message.substring(0, 100)}`);
    }

    done++;
    if (done % 25 === 0) {
      save();
      log(`  ── 进度: ${done}/${toSearch.length}, ${totalStudies} studies, ${withContact}有联系方式, ${errors} err ──`);
    }

    await new Promise(r => setTimeout(r, CTGOV_DELAY_MS));
  }

  save();
  const mins = ((Date.now() - t0) / 60000).toFixed(1);

  log('');
  log('══════════════════════════════════════');
  log(`CT.gov 补扫完成! 耗时: ${mins} 分钟`);
  log(`搜索: ${done} APIs, ${totalStudies} studies`);
  log(`含联系方式: ${withContact} 条 (${(withContact/Math.max(totalStudies,1)*100).toFixed(1)}%)`);
  log(`错误: ${errors}`);
  log('══════════════════════════════════════');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
