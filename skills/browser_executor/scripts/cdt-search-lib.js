/**
 * CDT 搜索核心逻辑 (可复用模块)
 *
 * 导出:
 *   searchOneAPI(browser, apiName, opts) → { totalResults, filteredTotal, detailedTrials, newCursor, cursorHit }
 *   loadThrottle() → throttle config object
 *   connectBrowser() → Playwright browser (带重试)
 *   createWorkerContext(browser) → Playwright browser context (带 stealth)
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ── 节流配置 ──
const THROTTLE_DEFAULTS = {
  delay_between_apis_ms: [5000, 8000],
  delay_after_search_ms: [2000, 3000],
  delay_page_turn_ms: [2000, 3000],
  delay_after_page_load_ms: [2000, 3000],
  delay_detail_page_ms: [2000, 3000],
  delay_after_detail_load_ms: [2000, 3000],
  retry_429_base_ms: 15000,
  retry_429_max_ms: 90000
};

function loadThrottle() {
  try {
    const cfg = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', '..', 'config', 'cdt-throttle.json'), 'utf8'));
    return { ...THROTTLE_DEFAULTS, ...cfg };
  } catch { return { ...THROTTLE_DEFAULTS }; }
}

const THROTTLE = loadThrottle();
function randDelay(range) { return range[0] + Math.random() * (range[1] - range[0]); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 判断是否为浏览器断连类错误 ──
function isBrowserDeadError(err) {
  const msg = (err && err.message) || '';
  return /Target page, context or browser has been closed|browser has been closed|Target closed|has been disconnected|disconnect|Connection closed|WebSocket/i.test(msg);
}

// ── Stealth 配置 ──
const STEALTH_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox',
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-infobars', '--window-size=1280,720', '--disable-dev-shm-usage',
];
const STEALTH_INIT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
  window.chrome = { runtime: {} };
`;

// ── 浏览器连接 (带 429 重试) ──
async function connectBrowser() {
  if (!process.env.BROWSER_ENDPOINT) {
    return await chromium.launch({ headless: true, args: STEALTH_ARGS });
  }
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      return await chromium.connectOverCDP(process.env.BROWSER_ENDPOINT);
    } catch (e) {
      if (/429|Too Many Requests/i.test(e.message) && attempt < 6) {
        const wait = Math.min(THROTTLE.retry_429_base_ms * attempt + Math.random() * 5000, THROTTLE.retry_429_max_ms);
        console.error(`[CDT] 429 连接限流, 等待 ${(wait/1000).toFixed(0)}s 重试 (${attempt}/6)...`);
        await sleep(wait);
      } else throw e;
    }
  }
}

// ── 创建 worker 上下文 (带 stealth) ──
async function createWorkerContext(browser) {
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
  });
  await context.addInitScript(STEALTH_INIT);
  return context;
}

// ── 安全关闭 page ──
async function safeClosePage(page) {
  if (!page) return;
  try { await page.close(); } catch (_) {}
}

// ── 安全关闭 context ──
async function safeCloseContext(context) {
  if (!context) return;
  try { await context.close(); } catch (_) {}
}

// ── 带重试的页面导航 (仅限页面级错误，不处理浏览器断连) ──
async function safeGoto(page, url, label, timeout = 60000) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      return;
    } catch (e) {
      // 浏览器断连 → 不重试，直接上抛
      if (isBrowserDeadError(e)) throw e;
      if (attempt < 3) {
        console.error(`[CDT] ${label} 导航失败, 重试 ${attempt}/3: ${e.message.substring(0, 80)}`);
        await sleep(3000 * attempt);
      } else throw e;
    }
  }
}

// ── 从页面提取搜索结果 (在 page.evaluate 中运行) ──
function extractSearchResults() {
  const pageInfo = document.querySelector('.pageInfo');
  let totalPages = 1, totalRecords = 0, currentPage = 1;
  if (pageInfo) {
    const m1 = pageInfo.textContent.match(/共\s*(\d+)\s*页/);
    const m2 = pageInfo.textContent.match(/共\s*(\d+)\s*条/);
    const m3 = pageInfo.textContent.match(/第\s*(\d+)\s*页/);
    if (m1) totalPages = parseInt(m1[1]);
    if (m2) totalRecords = parseInt(m2[1]);
    if (m3) currentPage = parseInt(m3[1]);
  }
  const table = document.querySelector('table.searchTable');
  const rows = table ? table.querySelectorAll('tbody tr') : [];
  const results = [];
  for (const row of rows) {
    const cells = row.querySelectorAll('td');
    if (cells.length >= 5) {
      const regNoLink = row.querySelector('a');
      results.push({
        seq: cells[0].textContent.trim(),
        regNo: cells[1] ? cells[1].textContent.trim() : '',
        status: cells[2].textContent.trim(),
        drugName: cells[3].textContent.trim(),
        indication: cells[4].textContent.trim(),
        title: cells[5] ? cells[5].textContent.trim() : '',
        detailId: regNoLink ? regNoLink.id : ''
      });
    }
  }
  return { pagination: { currentPage, totalPages, totalRecords }, results };
}

// ── 从详情页提取试验数据 (在 page.evaluate 中运行) ──
function extractDetailData(args) {
  const { regNo, searchStatus, searchDrugName, searchIndication, searchTitle } = args;
  const tables = document.querySelectorAll('table');
  const getText = (table, rowIdx, colIdx) => {
    try {
      const row = table.querySelectorAll('tr')[rowIdx];
      if (!row) return '';
      const cells = row.querySelectorAll('td, th');
      return cells[colIdx] ? cells[colIdx].textContent.trim().replace(/\s+/g, ' ') : '';
    } catch(e) { return ''; }
  };
  const result = { regNo, searchStatus, searchDrugName, searchIndication, searchTitle };
  if (tables[0]) {
    result.trialStatus = getText(tables[0], 0, 3) || searchStatus;
    result.applicantContact = getText(tables[0], 1, 1);
    result.firstPostDate = getText(tables[0], 1, 3);
    result.applicantName = getText(tables[0], 2, 1);
  }
  if (tables[1]) {
    result.drugName = getText(tables[1], 2, 1).replace(/曾用名:.*/g, '').trim() || searchDrugName;
    result.drugType = getText(tables[1], 3, 1);
    result.indication = getText(tables[1], 5, 1) || searchIndication;
    result.scientificTitle = getText(tables[1], 6, 1);
    result.publicTitle = getText(tables[1], 7, 1) || searchTitle;
    result.protocolNo = getText(tables[1], 8, 1);
    result.versionDate = getText(tables[1], 8, 3);
  }
  if (tables[2]) {
    result.applicantCount = getText(tables[2], 0, 1);
    result.contactName = getText(tables[2], 1, 1);
    result.contactPhone = getText(tables[2], 1, 3);
    result.contactEmail = getText(tables[2], 2, 1);
    result.contactAddress = getText(tables[2], 2, 3);
  }
  if (tables[3]) {
    result.trialCategory = getText(tables[3], 0, 1);
    result.trialPhase = getText(tables[3], 0, 3);
    result.phaseNote = getText(tables[3], 0, 5);
    result.designType = getText(tables[3], 0, 7);
    result.trialScope = getText(tables[3], 1, 5);
  }
  if (tables[13]) {
    result.piName = getText(tables[13], 0, 2);
    result.piDegree = getText(tables[13], 0, 4);
    result.piTitle = getText(tables[13], 0, 6);
    result.piPhone = getText(tables[13], 1, 1);
    result.piEmail = getText(tables[13], 1, 3);
    result.piAddress = getText(tables[13], 1, 5);
    result.piUnit = getText(tables[13], 2, 3);
  }
  if (tables[14]) {
    const siteRows = tables[14].querySelectorAll('tr');
    const sites = [];
    for (let si = 1; si < siteRows.length; si++) {
      const cells = siteRows[si].querySelectorAll('td');
      if (cells.length >= 6) {
        sites.push({ name: cells[1].textContent.trim(), pi: cells[2].textContent.trim(), region: cells[3].textContent.trim(), province: cells[4].textContent.trim(), city: cells[5].textContent.trim() });
      }
    }
    result.sites = sites;
  }
  if (tables[15]) {
    result.ethicsCommittee = getText(tables[15], 1, 1);
    result.ethicsConclusion = getText(tables[15], 1, 2);
    result.ethicsDate = getText(tables[15], 1, 3);
  }
  if (tables[16]) {
    result.targetEnrollment = getText(tables[16], 0, 1);
    result.actualEnrollment = getText(tables[16], 1, 1);
  }
  if (tables[17]) {
    result.firstConsentDate = getText(tables[17], 0, 1).replace(/国内：|；/g, '').trim();
    result.firstEnrollDate = getText(tables[17], 1, 1).replace(/国内：|；/g, '').trim();
    result.completionDate = getText(tables[17], 2, 1).replace(/国内：|；/g, '').trim();
  }
  return result;
}

// ── 获取 regNo 列表中的最大值 ──
function getMaxRegNo(results) {
  let max = '';
  for (const r of results) if (r.regNo > max) max = r.regNo;
  return max;
}

/**
 * 搜索一个 API 的 CDT 数据
 *
 * 生命周期:
 *   - 接受 browser 对象（由 pipeline 管理连接）
 *   - 内部为每个 API 创建独立 context + page，用完关闭
 *   - 搜索/翻页/详情阶段如遇到浏览器断连，自动重建 session 并重试
 *   - finally 块保证无论成功/失败都关闭 page 和 context
 *
 * @param {Playwright Browser} browser - 持久化浏览器连接
 * @param {string} apiName - API 中文名
 * @param {object} opts
 * @returns {{ totalResults, filteredTotal, detailedTrials, newCursor, cursorHit }}
 */
async function searchOneAPI(browser, apiName, opts = {}) {
  const {
    minYear = 0,
    cursor = '',
    maxPages = 5,
    maxDetails = 0,
    batchSize = 50,
    logPrefix = '[CDT]'
  } = opts;

  let context = null;
  let page = null;

  // ── 创建新 session (关闭旧的 → 创建新的) ──
  async function newSession(reason) {
    await safeClosePage(page);
    await safeCloseContext(context);
    page = null;
    context = null;

    // 检查浏览器连接是否还活着
    if (browser.isConnected && !browser.isConnected()) {
      throw new Error('BROWSER_DISCONNECTED: WebSocket 连接已断开');
    }

    context = await createWorkerContext(browser);
    page = await context.newPage();
    if (reason) console.error(`${logPrefix} ${apiName}: 新建 session (${reason})`);
  }

  try {
    // ══════════════════════════════════════
    // Step 1: 搜索
    // ══════════════════════════════════════
    await newSession(); // 首次创建 session

    const searchUrl = `https://www.chinadrugtrials.org.cn/clinicaltrials.searchlist.dhtml?keywords=${encodeURIComponent(apiName)}`;

    let searchData;
    try {
      await safeGoto(page, searchUrl, '搜索首页');
      await page.waitForSelector('table.searchTable', { timeout: 30000 });
      await sleep(randDelay(THROTTLE.delay_after_search_ms));
      searchData = await page.evaluate(extractSearchResults);
    } catch (e) {
      if (isBrowserDeadError(e)) {
        // 搜索阶段断连 → 重建 session 重试一次
        console.error(`${logPrefix} ${apiName}: 搜索阶段浏览器断连, 重建重试...`);
        await newSession('搜索断连重试');
        await safeGoto(page, searchUrl, '搜索首页(重试)');
        await page.waitForSelector('table.searchTable', { timeout: 30000 });
        await sleep(randDelay(THROTTLE.delay_after_search_ms));
        searchData = await page.evaluate(extractSearchResults);
      } else {
        throw e;
      }
    }

    console.error(`${logPrefix} 搜索: ${apiName}${cursor ? ` (增量, cursor=${cursor})` : ''} → ${searchData.pagination.totalRecords} 条, ${searchData.pagination.totalPages} 页`);

    let allResults = [...searchData.results];
    let globalMaxRegNo = getMaxRegNo(searchData.results);
    let cursorHit = false;

    if (cursor && globalMaxRegNo && globalMaxRegNo <= cursor) {
      console.error(`${logPrefix} ${apiName}: 游标停止: 首页最大登记号 ${globalMaxRegNo} <= cursor ${cursor}`);
      cursorHit = true;
    }

    // ══════════════════════════════════════
    // Step 2: 翻页
    // ══════════════════════════════════════
    if (!cursorHit && searchData.pagination.totalPages > 1) {
      const totalPages = Math.min(searchData.pagination.totalPages, maxPages);
      for (let pg = 2; pg <= totalPages; pg++) {
        await sleep(randDelay(THROTTLE.delay_page_turn_ms));
        try {
          await safeGoto(page, searchUrl, `第${pg}页`);
          await page.waitForSelector('table.searchTable', { timeout: 30000 });
          await sleep(1000);
          await page.evaluate((p) => gotopage(p), pg);
          await sleep(randDelay(THROTTLE.delay_after_page_load_ms));

          const pageResults = await page.evaluate(extractSearchResults).then(d => d.results);
          if (pageResults && pageResults.length > 0) {
            const pageMaxRegNo = getMaxRegNo(pageResults);
            if (cursor && pageMaxRegNo && pageMaxRegNo <= cursor) {
              console.error(`${logPrefix} ${apiName}: 游标停止: 第${pg}页最大登记号 ${pageMaxRegNo} <= cursor ${cursor}`);
              cursorHit = true;
              break;
            }
            allResults = allResults.concat(pageResults);
            if (pageMaxRegNo > globalMaxRegNo) globalMaxRegNo = pageMaxRegNo;
          }
        } catch (e) {
          if (isBrowserDeadError(e)) {
            // 翻页断连 → 丢失当前页数据，但不致命（已有首页+已翻页数据）
            console.error(`${logPrefix} ${apiName}: 第${pg}页浏览器断连, 停止翻页 (已获取 ${allResults.length} 条)`);
            break;
          }
          console.error(`${logPrefix} ${apiName}: 第${pg}页失败: ${e.message.substring(0, 100)}`);
        }
      }
    }

    // ══════════════════════════════════════
    // Step 2.5: 清洗 + 年份过滤 + 游标过滤
    // ══════════════════════════════════════
    allResults.forEach(r => {
      r.regNo = r.regNo.replace(/[\s\u200B\uFEFF\u00A0]/g, '').trim();
    });

    if (minYear > 0) {
      const before = allResults.length;
      allResults = allResults.filter(r => {
        const m = r.regNo.match(/CTR(\d{4})/i);
        if (!m) return true;
        return parseInt(m[1]) >= minYear;
      });
      console.error(`${logPrefix} ${apiName}: 年份过滤(>=${minYear}): ${before} → ${allResults.length} 条`);
    }

    if (cursor) {
      const before = allResults.length;
      allResults = allResults.filter(r => !r.regNo || r.regNo > cursor);
      console.error(`${logPrefix} ${apiName}: 游标过滤(>${cursor}): ${before} → ${allResults.length} 条`);
    }

    const filteredTotal = allResults.length;
    const newCursor = globalMaxRegNo || cursor || '';

    // ══════════════════════════════════════
    // Step 3: 详情页 (分批获取，断连时自动重建 session)
    // ══════════════════════════════════════
    const allDetailedTrials = [];
    let offset = 0;

    while (offset < filteredTotal) {
      const batchEnd = Math.min(offset + batchSize, filteredTotal);
      let batchItems = allResults.slice(offset, batchEnd);

      if (maxDetails > 0) {
        const remaining = maxDetails - allDetailedTrials.length;
        if (remaining <= 0) break;
        if (batchItems.length > remaining) batchItems = batchItems.slice(0, remaining);
      }

      for (let i = 0; i < batchItems.length; i++) {
        const r = batchItems[i];
        if (!r.regNo) continue;

        if (i > 0 || offset > 0) await sleep(randDelay(THROTTLE.delay_detail_page_ms));

        try {
          const detailUrl = `https://www.chinadrugtrials.org.cn/clinicaltrials.searchlistdetail.dhtml?reg_no=${encodeURIComponent(r.regNo)}`;
          await safeGoto(page, detailUrl, `详情 ${r.regNo}`);
          await page.waitForSelector('table', { timeout: 30000 });
          await sleep(randDelay(THROTTLE.delay_after_detail_load_ms));

          const detail = await page.evaluate(extractDetailData, {
            regNo: r.regNo,
            searchStatus: r.status,
            searchDrugName: r.drugName,
            searchIndication: r.indication.replace(/\n/g, ' '),
            searchTitle: r.title.replace(/\n/g, ' ')
          });
          allDetailedTrials.push(detail);
        } catch (e) {
          if (isBrowserDeadError(e)) {
            // ── 浏览器断连 → 重建 session 并重试当前详情页 ──
            console.error(`${logPrefix} ${apiName}: 详情 ${r.regNo} 浏览器断连, 重建 session 重试...`);
            try {
              await newSession('详情断连重试');
              const detailUrl = `https://www.chinadrugtrials.org.cn/clinicaltrials.searchlistdetail.dhtml?reg_no=${encodeURIComponent(r.regNo)}`;
              await safeGoto(page, detailUrl, `详情 ${r.regNo} (重试)`);
              await page.waitForSelector('table', { timeout: 30000 });
              await sleep(randDelay(THROTTLE.delay_after_detail_load_ms));

              const detail = await page.evaluate(extractDetailData, {
                regNo: r.regNo,
                searchStatus: r.status,
                searchDrugName: r.drugName,
                searchIndication: r.indication.replace(/\n/g, ' '),
                searchTitle: r.title.replace(/\n/g, ' ')
              });
              allDetailedTrials.push(detail);
              continue; // 重试成功，继续下一个
            } catch (retryErr) {
              // 重建后仍失败 → 如果是断连则上抛（让 pipeline 重连整个 browser）
              if (isBrowserDeadError(retryErr)) {
                throw new Error(`BROWSER_DISCONNECTED: 详情 ${r.regNo} 重建后仍断连`);
              }
              console.error(`${logPrefix} ${apiName}: 详情 ${r.regNo} 重建后仍失败: ${retryErr.message.substring(0, 80)}`);
              allDetailedTrials.push({
                regNo: r.regNo, searchStatus: r.status, searchDrugName: r.drugName,
                searchIndication: r.indication, searchTitle: r.title, error: retryErr.message
              });
            }
          } else {
            console.error(`${logPrefix} ${apiName}: 详情 ${r.regNo} 失败: ${e.message.substring(0, 100)}`);
            allDetailedTrials.push({
              regNo: r.regNo, searchStatus: r.status, searchDrugName: r.drugName,
              searchIndication: r.indication, searchTitle: r.title, error: e.message
            });
          }
        }
      }

      offset += batchSize;
      if (batchItems.length < batchSize) break;
    }

    if (cursorHit) console.error(`${logPrefix} ${apiName}: 📌 增量命中: 游标 ${cursor}, 新增 ${filteredTotal} 条`);

    return {
      totalResults: searchData.pagination.totalRecords,
      filteredTotal,
      detailedTrials: allDetailedTrials,
      newCursor,
      cursorHit
    };

  } finally {
    // ── 保证无论成功/失败都关闭 page 和 context ──
    await safeClosePage(page);
    await safeCloseContext(context);
  }
}

module.exports = {
  searchOneAPI,
  loadThrottle,
  connectBrowser,
  createWorkerContext,
  isBrowserDeadError,
  THROTTLE_DEFAULTS
};
