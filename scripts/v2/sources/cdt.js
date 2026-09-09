/**
 * CDT 数据源（chinadrugtrials.org.cn）— 浏览器采集 + DB 落库
 *  - 浏览器自动化知识复用 skills/browser_executor/scripts/cdt-search-lib.js（shared skill）
 *  - 本模块重写的是编排层: 游标读 meta、断连重试、结果映射、单事务落库（验收 #5/#6/#13）
 */
'use strict';

const path = require('path');
const enrichment = require('../../lib/enrichment');
const { prepare, withTransaction, DATA_FIELDS } = require('../store');

const CDT_LIB = path.join(__dirname, '..', '..', 'skills', 'browser_executor', 'scripts', 'cdt-search-lib.js');

// v1 mapTrial 知识重写（字段名以 cdt-search-lib 输出为准）
function mapTrial(t) {
  return {
    source: 'CDT',
    regNo: t.regNo,
    regDate: t.firstPostDate || '',
    sponsor: t.applicantName || '',
    status: t.searchStatus || t.trialStatus || '',
    drugName: t.searchDrugName || t.drugName || '',
    dosageForm: enrichment.extractDosageFormCN(t.searchDrugName || t.drugName || ''),
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
    condition: t.indication || t.searchIndication || ''
  };
}

function minYearFilter(trials, minYear) {
  return trials.filter(t => {
    const m = t.regNo.match(/CTR(\d{4})/i);
    if (!m) return true;
    return parseInt(m[1]) >= minYear;
  });
}

/**
 * 抓取一个 API 并落库（游标与数据同事务）
 * @returns { inserted, updated, newCursor, skipped }
 */
async function collectAPI(browser, api, { minYear, log = () => {} } = {}) {
  const lib = require(CDT_LIB);
  const { db, enName } = api;
  const cursorKey = `cdt_cursor:${enName}`;

  const result = await lib.searchOneAPI(browser, api.cnName, {
    minYear, cursor: api.cursor || undefined, maxPages: 5, batchSize: 50, logPrefix: '[CDT]'
  });
  const trials = minYearFilter(result.detailedTrials.map(mapTrial), minYear);

  const p = prepare(db);
  let inserted = 0, updated = 0;
  withTransaction(db, () => {
    for (const t of trials) {
      t.api = enName;
      if (p.exists.get(t.source, t.regNo)) updated++; else inserted++;
      p.insTrial.run(t.source, t.regNo, ...DATA_FIELDS.map(f => t[f] ?? null));
      p.insApi.run(t.source, t.regNo, enName, t.drugName ?? null);
    }
    if (result.newCursor) {
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(cursorKey, result.newCursor);
    }
  });

  const skipped = Boolean(api.cursor) && trials.length === 0;
  log(`[CDT] ${enName}(${api.cnName}) ${trials.length} 条${skipped ? ' (游标无新增)' : ''}`);
  return { inserted, updated, newCursor: result.newCursor, skipped };
}

/**
 * 全场景 CDT 采集（worker 池 + 主动/被动重连 — v1.2 知识）
 * @param apis: [{ db, enName, cnName, cursor }]（cnName 为空跳过）
 * @returns { done, totalNew, errors, skippedNoNew, failedApis }
 */
async function runCDT(db, apis, { workerCount = 2, minYear = 0, log = () => {} } = {}) {
  const lib = require(CDT_LIB);

  // ── 浏览器连接 ──
  const browsers = [];
  let lastErr;
  for (let w = 0; w < workerCount; w++) {
    try {
      if (w > 0) await new Promise(r => setTimeout(r, 2000));
      browsers.push(await lib.connectBrowser());
    } catch (e) {
      lastErr = e;
      log(`[CDT] Worker ${w + 1} 连接失败: ${e.message.substring(0, 100)}，以 ${w} 个 worker 继续`);
      break;
    }
  }
  if (browsers.length === 0) {
    // 验收 #13: 不得静默 —— 抛出，pipeline 层记录并标注新鲜度
    throw new Error(`无法创建任何浏览器连接，CDT 未能更新: ${lastErr ? lastErr.message.substring(0, 100) : 'unknown'}`);
  }

  // ── API 分片 ──
  const todo = apis.filter(a => a.cnName && a.db === db);
  const shards = Array.from({ length: browsers.length }, () => []);
  todo.forEach((a, i) => shards[i % shards.length].push(a));

  let done = 0, totalNew = 0, errors = 0, skippedNoNew = 0;
  const failedApis = [];

  async function reconnect(idx) {
    log(`[CDT][W${idx + 1}] 断连重连...`);
    try { await browsers[idx].close(); } catch (_) {}
    await new Promise(r => setTimeout(r, 3000 + Math.random() * 3000));
    browsers[idx] = await lib.connectBrowser();
  }

  async function work(idx, list) {
    let sinceConnect = 0;
    for (const api of list) {
      if (sinceConnect >= 25) { await reconnect(idx); sinceConnect = 0; }
      if (browsers[idx].isConnected && !browsers[idx].isConnected()) {
        await reconnect(idx); sinceConnect = 0;
      }
      try {
        const r = await collectAPI(browsers[idx], api, { minYear, log });
        sinceConnect++;
        if (r.skipped) skippedNoNew++; else totalNew += r.inserted;
      } catch (e) {
        errors++;
        failedApis.push(api.enName);
        log(`[CDT][W${idx + 1}] ${api.enName} 失败: ${e.message.substring(0, 120)}`);
        if (/Target page|browser has been closed|disconnect|WebSocket/i.test(e.message)) {
          try { await reconnect(idx); sinceConnect = 0; } catch (_) {}
        }
      }
      done++;
    }
  }

  await Promise.all(browsers.map((_, i) => work(i, shards[i])));
  for (const b of browsers) { try { await b.close(); } catch (_) {} }

  log(`[CDT] 完成: ${done} APIs, +${totalNew} 新, ${skippedNoNew} 游标无新增, ${errors} 失败${failedApis.length ? ` [${failedApis.join(',')}]` : ''}`);
  return { done, totalNew, errors, skippedNoNew, failedApis };
}

module.exports = { mapTrial, minYearFilter, collectAPI, runCDT };