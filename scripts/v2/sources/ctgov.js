/**
 * CT.gov 数据源 (REST, 无浏览器)
 *  - 全量拉取 + China 服务端预过滤 + 客户端精确过滤 + 2 年窗口
 *  - 重试/退避 走 lib/http.js（验收 #4）
 *  - 联系人提取优先级: centralContacts → 中国 site contacts
 *  - spawnerCollaboratorsModule（单数!）v1 踩过的坑写入注释
 */
'use strict';

const { getJSON } = require('../lib/http');
const enrichment = require('../../lib/enrichment');

const CTGOV_BASE = 'https://clinicaltrials.gov/api/v2/studies';
const PAGE_SIZE = 1000;
const TIMEOUT_MS = 30000;

async function fetchStudies(apiName, log) {
  const all = [];
  let token = null;
  do {
    const params = new URLSearchParams();
    params.set('query.term', apiName);
    params.set('query.locn', 'China');
    params.set('countTotal', 'true');
    params.set('pageSize', String(PAGE_SIZE));
    if (token) params.set('pageToken', token);
    const data = await getJSON(`${CTGOV_BASE}?${params}`, { timeoutMs: TIMEOUT_MS, log });
    if (data.studies) all.push(...data.studies);
    token = data.nextPageToken || null;
  } while (token);
  return all;
}

function ctgovToTrials(studies, apiName, cutoff) {
  const out = [];
  for (const s of studies) {
    const protocol = s.protocolSection || {};
    const ident = protocol.identificationModule || {};
    const status = protocol.statusModule || {};
    const design = protocol.designModule || {};
    const cond = protocol.conditionsModule || {};
    const sponsorMod = protocol.sponsorCollaboratorsModule || {};   // 单数 — v1 踩坑记录
    const contactsMod = protocol.contactsLocationsModule || {};
    const arms = protocol.armsInterventionsModule || {};

    const locs = contactsMod.locations || [];
    if (!locs.some(l => l.country === 'China')) continue;           // 精确中国过滤

    const interventions = (arms.interventions || []).map(iv => ({
      type: iv.type || '', name: iv.name || '', description: iv.description || ''
    }));

    let contactPhone = '', contactEmail = '', contactName = '';
    const central = contactsMod.centralContacts || [];
    if (central.length) {
      contactPhone = central[0].phone || '';
      contactEmail = central[0].email || '';
      contactName = central[0].name || '';
    } else {
      for (const loc of locs.filter(l => l.country === 'China')) {
        const valid = (loc.contacts || []).find(c => c.phone || c.email);
        if (valid) {
          contactPhone = valid.phone || '';
          contactEmail = valid.email || '';
          contactName = valid.name || '';
          break;
        }
      }
    }

    const chinaLocs = locs.filter(l => l.country === 'China');
    const piUnit = chinaLocs.slice(0, 2).map(l => l.facility || '').filter(Boolean).join('; ');
    const contactAddress = chinaLocs.slice(0, 2).map(l =>
      [l.city, l.state, l.zip].filter(Boolean).join(', ')).filter(Boolean).join('; ');

    const briefTitle = ident.briefTitle || '';
    const officialTitle = ident.officialTitle || '';
    const productName = enrichment.extractProductName(interventions, apiName);
    const dosageForm = enrichment.extractDosageForm(interventions, briefTitle, officialTitle);

    const regDate = status.studyFirstSubmitDate || status.studyFirstSubmitDateQC ||
                    status.dispFirstSubmitDate || '';
    if (cutoff && regDate && regDate < cutoff) continue;             // 2 年窗口

    out.push({
      source: 'CT.gov',
      regNo: ident.nctId || '',
      api: apiName,
      drugName: productName || apiName,
      regDate,
      lastUpdateDate: status.lastUpdateSubmitDate || status.studyFirstPostDate || '',
      sponsor: sponsorMod.leadSponsor?.name || '',
      status: status.overallStatus || '',
      dosageForm,
      trialType: design.studyType || '',
      contactName, contactPhone, contactEmail,
      piName: '', piUnit, contactAddress,
      briefTitle, officialTitle,
      targetEnrollment: design.enrollmentInfo ? String(design.enrollmentInfo.count || '') : '',
      phase: Array.isArray(design.phases) ? design.phases.join(', ') : '',
      condition: Array.isArray(cond.conditions) ? cond.conditions.join('; ') : ''
    });
  }
  return out;
}

// 单 API 拉取+转换（供 pipeline 与自检复用）
async function collectAPI(apiName, { cutoff, log = () => {} } = {}) {
  const studies = await fetchStudies(apiName, log);
  return ctgovToTrials(studies, apiName, cutoff);
}

module.exports = { fetchStudies, ctgovToTrials, collectAPI };