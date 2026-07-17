#!/usr/bin/env node
/**
 * chinadrugtrials.org.cn 搜索脚本（CLI 独立版）
 *
 * 独立 CLI 用法（向后兼容）: node cdt-search.js <API中文名> [输出文件路径] [选项]
 *
 * 核心搜索逻辑在 cdt-search-lib.js 中，本文件只是 CLI 包装。
 * Pipeline 并发模式不使用此脚本，而是直接 require('cdt-search-lib')。
 *
 * 选项:
 *   --min-year N     按登记号年份过滤 (CTR+四位年份+序号, 只保留 >= N)
 *   --cursor REGNO   增量游标: 只获取 regNo > REGNO 的新数据，遇到旧数据自动停止翻页
 *   --max-pages N    限制最大翻页数 (默认10)
 *   --max-details N  限制最大详情获取数 (默认0=不限)
 *   --offset N       详情页起始偏移量 (默认0)
 *   --limit N        每批详情页数量 (默认0=全部)
 */

const fs = require('fs');
const lib = require('./cdt-search-lib');

const API_NAME = process.argv[2];
const OUTPUT_FILE = process.argv[3] || '/tmp/cdt-result.json';

function getArg(name, defaultVal) {
  const idx = process.argv.indexOf(name);
  return (idx !== -1 && process.argv[idx + 1]) ? (defaultVal === '' ? process.argv[idx + 1] : (parseInt(process.argv[idx + 1]) || defaultVal)) : defaultVal;
}

const MAX_PAGES = getArg('--max-pages', 10);
const MIN_YEAR = getArg('--min-year', 0);
const OFFSET = getArg('--offset', 0);
const LIMIT = getArg('--limit', 0);
const MAX_DETAILS = getArg('--max-details', 0);
const CURSOR = getArg('--cursor', '');

if (!API_NAME) {
  console.error('用法: node cdt-search.js <API中文名> [输出文件] [--min-year N] [--cursor REGNO] [--max-pages N] [--offset N] [--limit N]');
  process.exit(1);
}

async function main() {
  const browser = await lib.connectBrowser();

  try {
    const result = await lib.searchOneAPI(browser, API_NAME, {
      minYear: MIN_YEAR,
      cursor: CURSOR,
      maxPages: MAX_PAGES,
      maxDetails: MAX_DETAILS,
      batchSize: LIMIT > 0 ? LIMIT : 50,
      logPrefix: '[CDT]'
    });

    // 处理 offset（CLI 模式支持分批调用）
    let detailedTrials = result.detailedTrials;
    if (OFFSET > 0) {
      detailedTrials = detailedTrials.slice(OFFSET);
    }
    if (LIMIT > 0) {
      detailedTrials = detailedTrials.slice(0, LIMIT);
    }

    const output = {
      apiName: API_NAME,
      searchDate: new Date().toISOString().slice(0, 10),
      source: 'chinadrugtrials.org.cn',
      totalResults: result.totalResults,
      extractedResults: result.detailedTrials.length,
      yearFiltered: MIN_YEAR > 0 ? MIN_YEAR : null,
      cursorUsed: CURSOR || null,
      cursorHit: result.cursorHit,
      newCursor: result.newCursor,
      newTrialsCount: result.filteredTotal,
      filteredTotal: result.filteredTotal,
      batchOffset: OFFSET,
      batchLimit: LIMIT,
      detailedTrials
    };

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
    console.log(JSON.stringify({
      success: true, file: OUTPUT_FILE, trials: detailedTrials.length,
      filteredTotal: result.filteredTotal, newCursor: result.newCursor,
      cursorHit: result.cursorHit, batchOffset: OFFSET, batchLimit: LIMIT
    }));

  } finally {
    // searchOneAPI 已内部关闭了 context/page，这里只需关闭 browser
    try { await browser.close(); } catch (_) {}
  }
}

main().catch(e => {
  console.error(`[CDT] 致命错误: ${e.message}`);
  process.exit(1);
});
