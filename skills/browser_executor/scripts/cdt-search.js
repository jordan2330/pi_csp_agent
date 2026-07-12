#!/usr/bin/env node
/**
 * chinadrugtrials.org.cn 搜索脚本
 *
 * 用法: node cdt-search.js <API中文名> [输出文件路径]
 *
 * 工作原理:
 *   1. 直接用 URL 参数搜索: ?keywords=关键词 (最可靠，不依赖表单交互)
 *   2. evaluate 提取搜索结果表格 + 分页信息
 *   3. 如有多页，用 gotopage(N) 翻页
 *   4. 对每条结果访问详情页，提取申请人/PI/机构/日期等完整信息
 *
 * 输出: JSON 格式的试验数据数组
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const API_NAME = process.argv[2];
const OUTPUT_FILE = process.argv[3] || '/tmp/cdt-result.json';
const BROWSER_JS = path.join(__dirname, 'browser.js');
const TIMEOUT = 120; // 单个脚本最大秒数

// --max-details N 限制详情页数量 (默认30, 0=全部)
let MAX_DETAILS = 30;
const maxIdx = process.argv.indexOf('--max-details');
if (maxIdx !== -1 && process.argv[maxIdx + 1]) {
  MAX_DETAILS = parseInt(process.argv[maxIdx + 1]) || 30;
}
// --max-pages N 限制最大翻页数 (默认10)
let MAX_PAGES = 10;
const maxPagesIdx = process.argv.indexOf('--max-pages');
if (maxPagesIdx !== -1 && process.argv[maxPagesIdx + 1]) {
  MAX_PAGES = parseInt(process.argv[maxPagesIdx + 1]) || 10;
}

if (!API_NAME) {
  console.error('用法: node cdt-search.js <API中文名> [输出文件] [--max-details N] [--max-pages N]');
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
    fs.unlinkSync(scriptFile);
    throw new Error(`${label} 失败: ${e.message}`);
  }
}

// ── Step 1: 搜索首页 ──
console.error(`[CDT] 搜索: ${API_NAME}`);

const searchUrl = `https://www.chinadrugtrials.org.cn/clinicaltrials.searchlist.dhtml?keywords=${encodeURIComponent(API_NAME)}`;

const searchResult = runScript({
  steps: [
    { action: 'navigate', url: searchUrl, timeout: 60000 },
    { action: 'wait', selector: 'table.searchTable', timeout: 30000 },
    { action: 'delay', ms: 1500 },
    {
      action: 'evaluate',
      script: `(() => {
        // 分页信息
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

        // 搜索结果表格
        const table = document.querySelector('table.searchTable');
        const rows = table ? table.querySelectorAll('tbody tr') : [];
        const results = [];
        for (const row of rows) {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 5) {
            const regNoLink = row.querySelector('a');
            const regNo = cells[1] ? cells[1].textContent.trim() : '';
            results.push({
              seq: cells[0].textContent.trim(),
              regNo: regNo,
              status: cells[2].textContent.trim(),
              drugName: cells[3].textContent.trim(),
              indication: cells[4].textContent.trim(),
              title: cells[5] ? cells[5].textContent.trim() : '',
              detailId: regNoLink ? regNoLink.id : ''
            });
          }
        }

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

let allResults = [...searchData.results];

// ── Step 2: 翻页 (如有多页) ──
if (searchData.pagination.totalPages > 1) {
  const maxPages = Math.min(searchData.pagination.totalPages, MAX_PAGES); // 可配置最大翻页
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
          {
            action: 'evaluate',
            script: `(() => {
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
            })()`
          }
        ]
      }, `第${page}页`);

      const pageResults = pageResult[1]; // index 1 = second evaluate
      if (pageResults && pageResults.length > 0) {
        allResults = allResults.concat(pageResults);
        console.error(`[CDT] 第${page}页: ${pageResults.length} 条`);
      }
    } catch (e) {
      console.error(`[CDT] 第${page}页失败: ${e.message}`);
    }
  }
}

console.error(`[CDT] 总计提取: ${allResults.length} 条搜索结果`);

// ── Step 3: 访问每条结果的详情页提取完整信息 ──
const detailedTrials = [];

const detailLimit = MAX_DETAILS > 0 ? Math.min(allResults.length, MAX_DETAILS) : allResults.length;
if (allResults.length > detailLimit) {
  console.error(`[CDT] 详情页限制: 只获取前 ${detailLimit}/${allResults.length} 条`);
}
for (let i = 0; i < detailLimit; i++) {
  const r = allResults[i];
  if (!r.regNo) continue;

  console.error(`[CDT] [${i+1}/${allResults.length}] 获取详情: ${r.regNo}...`);

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

            // Table 0: 基本信息 (登记号, 试验状态, 申请人联系人, 首次公示日期, 申请人名称)
            if (tables[0]) {
              result.trialStatus = getText(tables[0], 0, 3) || result.searchStatus;
              result.applicantContact = getText(tables[0], 1, 1);
              result.firstPostDate = getText(tables[0], 1, 3);
              result.applicantName = getText(tables[0], 2, 1);
            }

            // Table 1: 试验详情 (药物名称, 药物类型, 适应症, 试验题目等)
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

            // Table 3: 试验分类 (试验分类, 试验分期, 设计类型)
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
    // 至少保存搜索结果中的基本信息
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

console.error(`[CDT] 完成! 获取了 ${detailedTrials.length} 条详情`);

// ── 输出 ──
const output = {
  apiName: API_NAME,
  searchDate: new Date().toISOString().slice(0, 10),
  source: 'chinadrugtrials.org.cn',
  totalResults: searchData.pagination.totalRecords,
  extractedResults: allResults.length,
  detailedTrials: detailedTrials
};

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
console.log(JSON.stringify({ success: true, file: OUTPUT_FILE, trials: detailedTrials.length }));
