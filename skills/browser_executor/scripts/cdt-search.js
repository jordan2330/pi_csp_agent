#!/usr/bin/env node
/**
 * chinadrugtrials.org.cn 搜索脚本
 *
 * 用法: node cdt-search.js <API中文名> [输出文件路径] [选项]
 *
 * 选项:
 *   --min-year N     按登记号年份过滤 (CTR+四位年份+序号, 只保留 >= N)
 *   --cursor REGNO   增量游标: 只获取 regNo > REGNO 的新数据，遇到旧数据自动停止翻页
 *   --max-pages N    限制最大翻页数 (默认10)
 *   --max-details N  限制最大详情获取数 (默认0=不限)
 *   --offset N       详情页起始偏移量 (默认0)
 *   --limit N        每批详情页数量 (默认0=全部)
 *
 * 工作原理:
 *   1. 直接用 URL 参数搜索: ?keywords=关键词 (不依赖表单交互)
 *   2. evaluate 提取搜索结果表格 + 分页信息
 *   3. 逐页翻页，同时追踪游标 (最大 regNo):
 *      - 无游标: 翻完所有页（受 maxPages 限制）
 *      - 有游标: 遇到某页最大 regNo <= cursor 时立即停止（后面的全是旧数据）
 *   4. 按年份过滤 + 游标过滤 → 只保留新数据
 *   5. 对新数据分批获取详情页
 *
 * 输出: JSON 格式的试验数据，包含 newCursor (本次搜索到的最大 regNo)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const API_NAME = process.argv[2];
const OUTPUT_FILE = process.argv[3] || '/tmp/cdt-result.json';
const BROWSER_JS = path.join(__dirname, 'browser.js');
const TIMEOUT = 120; // 单个浏览器脚本最大秒数

// ── CLI 参数解析 ──
function getArg(name, defaultVal) {
  const idx = process.argv.indexOf(name);
  return (idx !== -1 && process.argv[idx + 1]) ? (defaultVal === '' ? process.argv[idx + 1] : (parseInt(process.argv[idx + 1]) || defaultVal)) : defaultVal;
}

const MAX_PAGES = getArg('--max-pages', 10);
const MIN_YEAR = getArg('--min-year', 0);
const OFFSET = getArg('--offset', 0);
const LIMIT = getArg('--limit', 0);
const MAX_DETAILS = getArg('--max-details', 0);
const CURSOR = getArg('--cursor', '');  // 增量游标: regNo 字符串

if (!API_NAME) {
  console.error('用法: node cdt-search.js <API中文名> [输出文件] [--min-year N] [--cursor REGNO] [--max-pages N] [--offset N] [--limit N]');
  process.exit(1);
}

function runScript(scriptObj, label) {
  const scriptFile = `/tmp/cdt-script-${Date.now()}.json`;
  fs.writeFileSync(scriptFile, JSON.stringify(scriptObj, null, 2));
  try {
    const stdout = execSync(`node ${BROWSER_JS} script ${scriptFile}`, {
      timeout: TIMEOUT * 1000,
      maxBuffer: 50 * 1024 * 1024,
      encoding: 'utf-8'
    });
    fs.unlinkSync(scriptFile);
    return JSON.parse(stdout);
  } catch (e) {
    try { fs.unlinkSync(scriptFile); } catch (_) {}
    throw new Error(`${label} 失败: ${e.message}`);
  }
}

// ── 提取表格的 evaluate 脚本（首页和翻页共用） ──
const EXTRACT_TABLE = `(() => {
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
  return results;
})()`;

// ── Step 1: 搜索首页 ──
console.error(`[CDT] 搜索: ${API_NAME}${CURSOR ? ` (增量, cursor=${CURSOR})` : ''}`);

const searchUrl = `https://www.chinadrugtrials.org.cn/clinicaltrials.searchlist.dhtml?keywords=${encodeURIComponent(API_NAME)}`;

const searchResult = runScript({
  steps: [
    { action: 'navigate', url: searchUrl, timeout: 60000 },
    { action: 'wait', selector: 'table.searchTable', timeout: 30000 },
    { action: 'delay', ms: 1500 },
    {
      action: 'evaluate',
      script: `(() => {
        const pageInfo = document.querySelector('.pageInfo');
        let totalPages = 1, totalRecords = 0, currentPage = 1;
        if (pageInfo) {
          const m1 = pageInfo.textContent.match(/共\\s*(\\d+)\\s*页/);
          const m2 = pageInfo.textContent.match(/共\\s*(\\d+)\\s*条/);
          const m3 = pageInfo.textContent.match(/第\\s*(\\d+)\\s*页/);
          if (m1) totalPages = parseInt(m1[1]);
          if (m2) totalRecords = parseInt(m2[1]);
          if (m3) currentPage = parseInt(m3[1]);
        }
        const results = ${EXTRACT_TABLE};
        return {
          url: window.location.href,
          keyword: document.getElementById('keywords') ? document.getElementById('keywords').value : '',
          pagination: { currentPage, totalPages, totalRecords },
          results: results
        };
      })()`
    }
  ]
}, '搜索');

const searchData = searchResult[0];
console.error(`[CDT] 搜索结果: ${searchData.pagination.totalRecords} 条, ${searchData.pagination.totalPages} 页`);
console.error(`[CDT] 首页提取: ${searchData.results.length} 条`);

// ── 游标辅助函数 ──
function getMaxRegNo(results) {
  let max = '';
  for (const r of results) {
    if (r.regNo > max) max = r.regNo;
  }
  return max;
}

let allResults = [...searchData.results];
let globalMaxRegNo = getMaxRegNo(searchData.results);
let cursorHit = false;

// 检查首页是否已触达游标
if (CURSOR && globalMaxRegNo && globalMaxRegNo <= CURSOR) {
  console.error(`[CDT] 游标停止: 首页最大登记号 ${globalMaxRegNo} <= cursor ${CURSOR}`);
  cursorHit = true;
}

// ── Step 2: 逐页翻页 + 游标控制 ──
if (!cursorHit && searchData.pagination.totalPages > 1) {
  const maxPages = Math.min(searchData.pagination.totalPages, MAX_PAGES);
  for (let page = 2; page <= maxPages; page++) {
    console.error(`[CDT] 翻页到第 ${page}/${maxPages} 页...`);
    try {
      const pageResult = runScript({
        steps: [
          { action: 'navigate', url: searchUrl, timeout: 60000 },
          { action: 'wait', selector: 'table.searchTable', timeout: 30000 },
          { action: 'delay', ms: 1000 },
          { action: 'evaluate', script: `gotopage(${page})` },
          { action: 'delay', ms: 2500 },
          { action: 'evaluate', script: EXTRACT_TABLE }
        ]
      }, `第${page}页`);

      const pageResults = pageResult[1];
      if (pageResults && pageResults.length > 0) {
        const pageMaxRegNo = getMaxRegNo(pageResults);

        if (CURSOR && pageMaxRegNo && pageMaxRegNo <= CURSOR) {
          // 本页最大 regNo <= cursor → 后面全是旧数据，停止翻页
          console.error(`[CDT] 游标停止: 第${page}页最大登记号 ${pageMaxRegNo} <= cursor ${CURSOR}`);
          cursorHit = true;
          break;
        }

        allResults = allResults.concat(pageResults);
        if (pageMaxRegNo > globalMaxRegNo) globalMaxRegNo = pageMaxRegNo;
        console.error(`[CDT] 第${page}页: ${pageResults.length} 条`);
      }
    } catch (e) {
      console.error(`[CDT] 第${page}页失败: ${e.message}`);
    }
  }
}

console.error(`[CDT] 总计提取: ${allResults.length} 条搜索结果`);

// ── Step 2.5: 清洗 + 年份过滤 + 游标过滤 ──
// 清洗 regNo
allResults.forEach(r => {
  r.regNo = r.regNo.replace(/[\s\u200B\uFEFF\u00A0]/g, '').trim();
});

// 年份过滤
if (MIN_YEAR > 0) {
  const before = allResults.length;
  const rejected = [];
  allResults = allResults.filter(r => {
    const m = r.regNo.match(/CTR(\d{4})/i);
    if (!m) return true;
    const year = parseInt(m[1]);
    if (year < MIN_YEAR) {
      if (rejected.length < 5) rejected.push(r.regNo);
      return false;
    }
    return true;
  });
  console.error(`[CDT] 年份过滤(>=${MIN_YEAR}): ${before} → ${allResults.length} 条`);
  if (rejected.length > 0) {
    console.error(`[CDT] 过滤样例(前5条): ${rejected.join(', ')}`);
  }
}

// 游标过滤: 只保留 regNo > CURSOR 的新数据
let cursorFiltered = 0;
if (CURSOR) {
  const before = allResults.length;
  allResults = allResults.filter(r => {
    if (!r.regNo) return true; // 无 regNo 的保留
    return r.regNo > CURSOR;
  });
  cursorFiltered = before - allResults.length;
  console.error(`[CDT] 游标过滤(>${CURSOR}): ${before} → ${allResults.length} 条 (移除 ${cursorFiltered} 条已知数据)`);
}

// ── Step 3: 分批访问详情页 ──
const filteredTotal = allResults.length;
const batchStart = OFFSET;
const batchEnd = LIMIT > 0 ? Math.min(OFFSET + LIMIT, filteredTotal) : filteredTotal;
let batchItems = allResults.slice(batchStart, batchEnd);

// max-details 限制
if (MAX_DETAILS > 0 && batchItems.length > MAX_DETAILS) {
  console.error(`[CDT] max-details 限制: ${batchItems.length} → ${MAX_DETAILS} 条`);
  batchItems = batchItems.slice(0, MAX_DETAILS);
}

console.error(`[CDT] 详情批次: [${batchStart}, ${batchEnd}) / ${filteredTotal} 条, 本次获取 ${batchItems.length} 条`);

const detailedTrials = [];

for (let i = 0; i < batchItems.length; i++) {
  const r = batchItems[i];
  if (!r.regNo) continue;

  console.error(`[CDT] [${batchStart + i + 1}/${filteredTotal}] 获取详情: ${r.regNo}...`);

  try {
    const detailUrl = `https://www.chinadrugtrials.org.cn/clinicaltrials.searchlistdetail.dhtml?reg_no=${encodeURIComponent(r.regNo)}`;

    const detailResult = runScript({
      steps: [
        { action: 'navigate', url: detailUrl, timeout: 60000 },
        { action: 'wait', selector: 'table', timeout: 30000 },
        { action: 'delay', ms: 2000 },
        {
          action: 'evaluate',
          script: `(() => {
            const tables = document.querySelectorAll('table');
            const getText = (table, rowIdx, colIdx) => {
              try {
                const row = table.querySelectorAll('tr')[rowIdx];
                if (!row) return '';
                const cells = row.querySelectorAll('td, th');
                return cells[colIdx] ? cells[colIdx].textContent.trim().replace(/\\s+/g, ' ') : '';
              } catch(e) { return ''; }
            };

            const result = {
              regNo: '${r.regNo}',
              searchStatus: '${r.status.replace(/'/g, "\\'")}',
              searchDrugName: '${r.drugName.replace(/'/g, "\\'")}',
              searchIndication: '${r.indication.replace(/'/g, "\\'").replace(/\\n/g, ' ')}',
              searchTitle: '${r.title.replace(/'/g, "\\'").replace(/\\n/g, ' ')}'
            };

            // Table 0: 基本信息
            if (tables[0]) {
              result.trialStatus = getText(tables[0], 0, 3) || result.searchStatus;
              result.applicantContact = getText(tables[0], 1, 1);
              result.firstPostDate = getText(tables[0], 1, 3);
              result.applicantName = getText(tables[0], 2, 1);
            }

            // Table 1: 试验详情
            if (tables[1]) {
              result.drugName = getText(tables[1], 2, 1).replace(/曾用名:.*/g, '').trim() || result.searchDrugName;
              result.drugType = getText(tables[1], 3, 1);
              result.indication = getText(tables[1], 5, 1) || result.searchIndication;
              result.scientificTitle = getText(tables[1], 6, 1);
              result.publicTitle = getText(tables[1], 7, 1) || result.searchTitle;
              result.protocolNo = getText(tables[1], 8, 1);
              result.versionDate = getText(tables[1], 8, 3);
            }

            // Table 2: 申请人详情
            if (tables[2]) {
              result.applicantCount = getText(tables[2], 0, 1);
              result.contactName = getText(tables[2], 1, 1);
              result.contactPhone = getText(tables[2], 1, 3);
              result.contactEmail = getText(tables[2], 2, 1);
              result.contactAddress = getText(tables[2], 2, 3);
            }

            // Table 3: 试验分类
            if (tables[3]) {
              result.trialCategory = getText(tables[3], 0, 1);
              result.trialPhase = getText(tables[3], 0, 3);
              result.phaseNote = getText(tables[3], 0, 5);
              result.designType = getText(tables[3], 0, 7);
              result.trialScope = getText(tables[3], 1, 5);
            }

            // Table 13: 主要研究者
            if (tables[13]) {
              result.piName = getText(tables[13], 0, 2);
              result.piDegree = getText(tables[13], 0, 4);
              result.piTitle = getText(tables[13], 0, 6);
              result.piPhone = getText(tables[13], 1, 1);
              result.piEmail = getText(tables[13], 1, 3);
              result.piAddress = getText(tables[13], 1, 5);
              result.piUnit = getText(tables[13], 2, 3);
            }

            // Table 14: 试验机构
            if (tables[14]) {
              const siteRows = tables[14].querySelectorAll('tr');
              const sites = [];
              for (let i = 1; i < siteRows.length; i++) {
                const cells = siteRows[i].querySelectorAll('td');
                if (cells.length >= 6) {
                  sites.push({
                    name: cells[1].textContent.trim(),
                    pi: cells[2].textContent.trim(),
                    region: cells[3].textContent.trim(),
                    province: cells[4].textContent.trim(),
                    city: cells[5].textContent.trim()
                  });
                }
              }
              result.sites = sites;
            }

            // Table 15: 伦理审批
            if (tables[15]) {
              result.ethicsCommittee = getText(tables[15], 1, 1);
              result.ethicsConclusion = getText(tables[15], 1, 2);
              result.ethicsDate = getText(tables[15], 1, 3);
            }

            // Table 16: 入组人数
            if (tables[16]) {
              result.targetEnrollment = getText(tables[16], 0, 1);
              result.actualEnrollment = getText(tables[16], 1, 1);
            }

            // Table 17: 日期
            if (tables[17]) {
              result.firstConsentDate = getText(tables[17], 0, 1).replace(/国内：|；/g, '').trim();
              result.firstEnrollDate = getText(tables[17], 1, 1).replace(/国内：|；/g, '').trim();
              result.completionDate = getText(tables[17], 2, 1).replace(/国内：|；/g, '').trim();
            }

            return result;
          })()`
        }
      ]
    }, `详情 ${r.regNo}`);

    detailedTrials.push(detailResult[0]);
  } catch (e) {
    console.error(`[CDT] 详情 ${r.regNo} 失败: ${e.message}`);
    detailedTrials.push({
      regNo: r.regNo,
      searchStatus: r.status,
      searchDrugName: r.drugName,
      searchIndication: r.indication,
      searchTitle: r.title,
      error: e.message
    });
  }
}

console.error(`[CDT] 批次完成! 获取了 ${detailedTrials.length} 条详情 (共 ${filteredTotal} 条待获取)`);
if (cursorHit) console.error(`[CDT] 📌 增量命中: 游标 ${CURSOR}, 新增 ${filteredTotal} 条`);

// ── 输出 ──
const newCursor = globalMaxRegNo || CURSOR || '';
const output = {
  apiName: API_NAME,
  searchDate: new Date().toISOString().slice(0, 10),
  source: 'chinadrugtrials.org.cn',
  totalResults: searchData.pagination.totalRecords,
  extractedResults: allResults.length,
  yearFiltered: MIN_YEAR > 0 ? MIN_YEAR : null,
  cursorUsed: CURSOR || null,
  cursorHit: cursorHit,
  newCursor: newCursor,
  newTrialsCount: filteredTotal,
  filteredTotal: filteredTotal,
  batchOffset: OFFSET,
  batchLimit: LIMIT,
  detailedTrials: detailedTrials
};

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
console.log(JSON.stringify({
  success: true,
  file: OUTPUT_FILE,
  trials: detailedTrials.length,
  filteredTotal: filteredTotal,
  newCursor: newCursor,
  cursorHit: cursorHit,
  batchOffset: OFFSET,
  batchLimit: LIMIT
}));
