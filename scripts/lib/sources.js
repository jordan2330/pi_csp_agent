/**
 * 数据来源统一接口
 *  - CT.gov: REST API (纯 HTTP，无需浏览器)
 *  - CDT:    chinadrugtrials.org.cn (通过 browser_executor 浏览器脚本)
 *
 * 两个来源的数据格式不同，这里统一转换为 trials 数组供 pipeline 使用。
 *
 * 增量机制:
 *  - CT.gov: 每次拉取全部结果（API 快，~5分钟/251API），run-pipeline.js 对比缓存检测新增
 *  - CDT:    使用 --cursor REGNO 参数，只获取比已知 regNo 更新的数据，遇到旧数据自动停止翻页
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { extractProductName, extractDosageForm } = require('./enrichment');

// ══════════════════════════════════════════════════
// CT.gov REST API v2
// ══════════════════════════════════════════════════

const CTGOV_BASE = 'https://clinicaltrials.gov/api/v2/studies';
const CTGOV_PAGE_SIZE = 1000;
const CTGOV_TIMEOUT_MS = 30000;

/**
 * GET /v2/studies?query.term=<api>&query.locn=China&countTotal=true&pageSize=1000
 *
 * 服务端预过滤：query.locn=China 只返回与中国相关的试验，
 * 大幅减少数据传输（通常减少 80-95%），多数 API 一页即可返回。
 * ctgovToTrials() 再做客户端精确过滤 (locations[].country === 'China')。
 *
 * 增量检测在 run-pipeline.js 通过对比缓存 NCT ID 实现。
 */
async function ctgovFetch(apiName) {
  const allStudies = [];
  let nextPageToken = null;

  do {
    const params = new URLSearchParams();
    params.set('query.term', apiName);
    params.set('query.locn', 'China');  // 服务端预过滤：中国相关试验
    params.set('countTotal', 'true');
    params.set('pageSize', String(CTGOV_PAGE_SIZE));
    if (nextPageToken) {
      params.set('pageToken', nextPageToken);
    }

    const url = `${CTGOV_BASE}?${params.toString()}`;
    const data = await httpGetJSON(url);

    if (data.studies) {
      allStudies.push(...data.studies);
    }

    nextPageToken = data.nextPageToken || null;
  } while (nextPageToken);

  return {
    totalCount: allStudies.length,
    studies: allStudies
  };
}

/**
 * 将 CT.gov API 返回的 studies 统一转换为 trials 数组
 *
 * 只保留在中国有试验地点 (locations[].country === 'China') 的试验。
 * CT.gov 是全球数据库，包含韩国/美国/欧洲/日本等国的试验，与 CSP 中国市场无关。
 * 中国相关试验的价值：中国药企去 FDA 注册 → 产品在中国生产 → 要卖去美国，
 * 这类企业面临中美双重监管，对亚硝胺控制需求更迫切。
 *
 * 联系方式提取优先级：
 *   1. centralContacts（试验总体联系人，通常有电话/邮箱）
 *   2. locations[].contacts（各试验点联系人，centralContacts 为空时的兜底）
 *
 * 注意：CT.gov API 字段名是 sponsorCollaboratorsModule（单数），
 *       不是 sponsorsCollaboratorsModule（复数），否则 sponsor 全部为空。
 */
function ctgovToTrials(apiResult, apiName) {
  const allStudies = apiResult.studies || [];

  // ── 中国过滤：只保留至少有一个 location.country === 'China' 的试验 ──
  const chinaStudies = allStudies.filter(s => {
    const locs = (s.protocolSection?.contactsLocationsModule || {}).locations || [];
    return locs.some(l => l.country === 'China');
  });

  return chinaStudies.map(s => {
    const protocol = s.protocolSection || {};
    const ident = protocol.identificationModule || {};
    const status = protocol.statusModule || {};
    const design = protocol.designModule || {};
    const conditionsMod = protocol.conditionsModule || {};
    // 注意：字段名是 sponsorCollaboratorsModule（单数），不是 sponsors
    const sponsorMod = protocol.sponsorCollaboratorsModule || {};
    const contactsMod = protocol.contactsLocationsModule || {};
    const armsInterventions = protocol.armsInterventionsModule || {};
    const interventions = (armsInterventions.interventions || []).map(iv => ({
      type: iv.type || '',
      name: iv.name || '',
      description: iv.description || ''
    }));

    // ── 提取申办方 ──
    const sponsorName = sponsorMod.leadSponsor?.name || '';

    // ── 提取联系方式（优先 centralContacts，兜底 locations[].contacts） ──
    let contactPhone = '', contactEmail = '', contactName = '';
    const centralContacts = contactsMod.centralContacts || [];
    if (centralContacts.length > 0) {
      contactPhone = centralContacts[0].phone || '';
      contactEmail = centralContacts[0].email || '';
      contactName = centralContacts[0].name || '';
    } else {
      // 兜底：从中国试验点的 contacts 中提取
      const chinaLocs = (contactsMod.locations || []).filter(l => l.country === 'China');
      for (const loc of chinaLocs) {
        const locContacts = loc.contacts || [];
        const valid = locContacts.find(c => c.phone || c.email);
        if (valid) {
          contactPhone = valid.phone || '';
          contactEmail = valid.email || '';
          contactName = valid.name || '';
          break;
        }
      }
    }

    // ── 提取试验机构（中国试验点 facility 名称，最多2个） ──
    const chinaLocs = (contactsMod.locations || []).filter(l => l.country === 'China');
    const piUnit = chinaLocs.slice(0, 2).map(l => l.facility || '').filter(Boolean).join('; ');

    // ── 提取地址（中国试验点的 city/state/zip 拼接，最多2个） ──
    const contactAddress = chinaLocs.slice(0, 2).map(l => {
      const parts = [l.city, l.state, l.zip].filter(Boolean);
      return parts.join(', ');
    }).filter(Boolean).join('; ');

    // ── 使用 enrichment.js 提取产品名和剂型 ──
    const briefTitle = ident.briefTitle || '';
    const officialTitle = ident.officialTitle || '';
    const productName = extractProductName(interventions, apiName);
    const dosageForm = extractDosageForm(interventions, briefTitle, officialTitle);

    // ── 试验分期和适应症 ──
    const phase = (Array.isArray(design.phases) && design.phases.length > 0) ? design.phases.join(', ') : '';
    const condition = (Array.isArray(conditionsMod.conditions) && conditionsMod.conditions.length > 0) ? conditionsMod.conditions.join('; ') : '';

    // ── 其他字段 ──
    const drugName = productName || apiName;
    const nctId = ident.nctId || '';
    const regDate = status.studyFirstSubmitDate ||
                    status.studyFirstSubmitDateQC ||
                    status.dispFirstSubmitDate || '';
    const lastUpdate = status.lastUpdateSubmitDate ||
                       status.studyFirstPostDate ||
                       status.resultsFirstPostDate || '';

    return {
      source: 'CT.gov',
      regNo: nctId,
      regDate: regDate,
      lastUpdateDate: lastUpdate,
      sponsor: sponsorName,
      status: status.overallStatus || '',
      drugName: drugName,
      dosageForm: dosageForm,
      trialType: design.studyType || '',
      contactName: contactName,
      contactPhone: contactPhone,
      contactEmail: contactEmail,
      piName: '',
      piUnit: piUnit,
      contactAddress: contactAddress,
      briefTitle: briefTitle,
      officialTitle: officialTitle,
      targetEnrollment: design.enrollmentInfo ? String(design.enrollmentInfo.count || '') : '',
      phase: phase,
      condition: condition,
      isNew: true
    };
  });
}

// ══════════════════════════════════════════════════
// CDT (chinadrugtrials.org.cn) — 浏览器脚本
// ══════════════════════════════════════════════════

/**
 * 执行 cdt-search.js 获取 CDT 试验数据
 *
 * 支持增量: 传入 cursor 则 cdt-search.js 会在翻页时自动检测:
 *   - 遇到某页最大 regNo <= cursor → 停止翻页（后面全是旧数据）
 *   - 只获取 regNo > cursor 的新数据
 *   - 返回 newCursor 供下次使用
 *
 * 批量获取详情: 通过 batchSize 分批调用 cdt-search.js
 *   每次调用是独立进程，避免单进程超时
 *
 * @param {string} nameCN - API 中文名
 * @param {string} cdtScriptPath - cdt-search.js 路径
 * @param {object} opts
 * @param {number} opts.maxPages - 最大翻页数
 * @param {number} opts.timeout - 单次执行超时(ms)
 * @param {number} opts.minYear - 最小年份过滤
 * @param {number} opts.batchSize - 每批详情数
 * @param {string} opts.cursor - 增量游标 (regNo)，传入则只获取更新的数据
 * @returns { trials, totalResults, filteredTotal, filterStats, newCursor }
 */
function runCDTSearch(nameCN, cdtScriptPath, opts = {}) {
  const { maxPages = 5, timeout = 1200000, minYear = 0, batchSize = 50, cursor = '' } = opts;

  let allTrials = [];
  let totalResults = 0;
  let filteredTotal = 0;
  let offset = 0;
  let newCursor = cursor || '';

  let filterStats = { total: 0, filtered: 0, year: minYear, cursor: cursor || null };

  while (true) {
    const tmpFile = `/tmp/cdt-${Date.now()}-${offset}.json`;
    let cmd = `node "${cdtScriptPath}" "${nameCN}" "${tmpFile}" --max-pages ${maxPages} --offset ${offset} --limit ${batchSize}`;
    if (minYear > 0) cmd += ` --min-year ${minYear}`;
    if (cursor) cmd += ` --cursor ${cursor}`;

    const spawn = spawnSync('/bin/sh', ['-c', cmd], {
      timeout,
      maxBuffer: 50 * 1024 * 1024,
      encoding: 'utf-8'
    });
    if (spawn.error) {
      throw new Error(`cdt-search.js 执行失败: ${spawn.error.message}`);
    }
    if (spawn.status !== 0) {
      const stderrInfo = (spawn.stderr || '').substring(0, 300);
      throw new Error(`cdt-search.js 退出码 ${spawn.status}: ${stderrInfo}`);
    }
    const stderrText = spawn.stderr || '';

    if (!fs.existsSync(tmpFile)) break;

    let cdtData;
    try {
      cdtData = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }
    }

    if (offset === 0) {
      totalResults = cdtData.totalResults || 0;
      filteredTotal = cdtData.filteredTotal || 0;
      // 从 stderr 解析年份过滤信息
      const filterMatch = stderrText.match(/年份过滤\(>=(\d+)\):\s*(\d+)\s*→\s*(\d+)/);
      filterStats = {
        total: cdtData.extractedResults || totalResults,
        filtered: filteredTotal,
        year: minYear,
        cursor: cursor || null,
        filterLog: filterMatch ? { before: +filterMatch[2], after: +filterMatch[3] } : null
      };
    }

    // 更新游标
    if (cdtData.newCursor && cdtData.newCursor > newCursor) {
      newCursor = cdtData.newCursor;
    }

    const batchTrials = (cdtData.detailedTrials || []);
    allTrials = allTrials.concat(batchTrials.map(mapTrial));

    // 如果本批不足 batchSize，说明已取完
    if (batchTrials.length < batchSize) break;

    offset += batchSize;
    if (offset >= filteredTotal) break;
  }

  // ── 二次校验：过滤掉任何 regNo 年份不符合 minYear 的结果 ──
  if (minYear > 0 && allTrials.length > 0) {
    const before = allTrials.length;
    allTrials = allTrials.filter(t => {
      const m = t.regNo.match(/CTR(\d{4})/i);
      if (!m) return true;
      return parseInt(m[1]) >= minYear;
    });
    const removed = before - allTrials.length;
    if (removed > 0) {
      filterStats.postFilterRemoved = removed;
    }
  }

  return { trials: allTrials, totalResults, filteredTotal, filterStats, newCursor };
}

function mapTrial(t) {
  return {
    source: 'CDT',
    regNo: t.regNo,
    regDate: t.firstPostDate || '',
    sponsor: t.applicantName || '',
    status: t.searchStatus || t.trialStatus || '',
    drugName: t.searchDrugName || t.drugName || '',
    dosageForm: '',
    trialType: [t.trialCategory, t.trialScope].filter(Boolean).join('; ') || '',
    contactName: t.contactName || '',
    contactPhone: t.contactPhone || '',
    contactEmail: t.contactEmail || '',
    piName: t.piName || '',
    piUnit: t.piUnit || '',
    contactAddress: t.contactAddress || '',
    briefTitle: t.publicTitle || t.searchTitle || '',
    officialTitle: t.scientificTitle || '',
    targetEnrollment: t.targetEnrollment || '',
    phase: t.trialPhase || '',
    condition: t.indication || t.searchIndication || '',
    isNew: true
  };
}

// ══════════════════════════════════════════════════
// HTTP 工具
// ══════════════════════════════════════════════════

function httpGetJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: CTGOV_TIMEOUT_MS,
      headers: { 'Accept': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

// ══════════════════════════════════════════════════
// CDT 持久连接搜索 (pipeline worker 模式)
// ══════════════════════════════════════════════════

/**
 * 使用持久 browser 搜索单个 API (pipeline worker 专用)
 *
 * @param {Playwright Browser} browser - 持久浏览器连接
 * @param {string} nameCN - API 中文名
 * @param {object} opts
 * @param {number} opts.maxPages - 最大翻页数
 * @param {number} opts.minYear - 最小年份过滤
 * @param {number} opts.batchSize - 详情页每批大小
 * @param {string} opts.cursor - 增量游标
 * @param {string} opts.logPrefix - 日志前缀 (如 "[W1]")
 * @returns { trials, totalResults, filteredTotal, filterStats, newCursor }
 */
async function cdtSearchOneAPI(browser, nameCN, opts = {}) {
  const { maxPages = 5, minYear = 0, batchSize = 50, cursor = '', logPrefix = '[CDT]' } = opts;
  const cdtSearchLib = require(path.join(__dirname, '..', '..', 'skills', 'browser_executor', 'scripts', 'cdt-search-lib'));

  const result = await cdtSearchLib.searchOneAPI(browser, nameCN, {
    minYear,
    cursor,
    maxPages,
    batchSize,
    logPrefix
  });

  const trials = result.detailedTrials.map(mapTrial);

  // 二次校验: 过滤掉任何 regNo 年份不符合 minYear 的结果
  let postFilterRemoved = 0;
  let filtered = trials;
  if (minYear > 0 && filtered.length > 0) {
    const before = filtered.length;
    filtered = filtered.filter(t => {
      const m = t.regNo.match(/CTR(\d{4})/i);
      if (!m) return true;
      return parseInt(m[1]) >= minYear;
    });
    postFilterRemoved = before - filtered.length;
  }

  return {
    trials: filtered,
    totalResults: result.totalResults,
    filteredTotal: result.filteredTotal,
    filterStats: {
      total: result.totalResults,
      filtered: result.filteredTotal,
      year: minYear,
      cursor: cursor || null,
      postFilterRemoved: postFilterRemoved > 0 ? postFilterRemoved : undefined
    },
    newCursor: result.newCursor
  };
}

module.exports = { ctgovFetch, ctgovToTrials, runCDTSearch, cdtSearchOneAPI };
