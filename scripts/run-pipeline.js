#!/usr/bin/env node
/**
 * CSP 商机发掘 Pipeline — 薄编排器（场景无关）
 *
 * 用法：
 *   node scripts/run-pipeline.js [scenario]   # 默认 nitrosamine
 *
 * 增量机制（核心设计）：
 *   每次运行都搜索所有 251 个 API，但使用游标只获取新增数据：
 *   - CT.gov: 每次拉取全部结果（API快），对比缓存 NCT ID 检测新增试验
 *   - CDT:    每个 API 记录 last_cdt_regno，传 --cursor 只获取更新的登记号，遇到旧数据自动停止翻页
 *
 * search_mode 控制：
 *   "full"        → 重置所有游标，全量重搜所有 API，完成后自动改回 incremental
 *   "incremental" → 使用游标，只获取新增数据（默认模式）
 *
 * 三阶段（场景专属逻辑通过 scenarios/<name>/ 注入）：
 *   Phase 0: FDA 列表年龄检查（超过 90 天提醒刷新）
 *   Phase 1: 缓存数据检查
 *   Phase 2: 双源搜索（CT.gov REST API + CDT 浏览器脚本）—— 通用 lib/sources.js
 *   Phase 3: 快照生成 + 报告生成 —— 通用 lib/snapshot.js + lib/report.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WS = '/workspace';
const CONFIG_DIR = path.join(WS, 'config');
const OUTPUT_DIR = path.join(WS, 'output');
const RUNS_DIR = path.join(OUTPUT_DIR, 'runs');
const SEARCH_CONFIG = path.join(CONFIG_DIR, 'search-config.json');
const ERR_LOG = path.join(RUNS_DIR, 'errors.log');
const CDT_SEARCH_LIB = path.join(WS, 'skills/browser_executor/scripts/cdt-search-lib.js');
const CDT_WORKER_COUNT = 2; // browserless 并发限制严格, 2 个 worker 更稳定; 每 25 个 API 主动重连回收内存

const CTGOV_DELAY_MS = 800;
// CDT 节流配置: 从 config/cdt-throttle.json 读取
const CDT_THROTTLE = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(WS, 'config', 'cdt-throttle.json'), 'utf8')); } catch { return { delay_between_apis_ms: [5000, 8000] }; }
})();
const CDT_DELAY_RANGE = CDT_THROTTLE.delay_between_apis_ms || [5000, 8000];
const FDA_REFRESH_DAYS = 90;  // FDA 列表建议刷新周期
const today = new Date();
const todayStr = today.toISOString().slice(0, 10);
const cutoff = new Date(today);
cutoff.setFullYear(cutoff.getFullYear() - 2);

// ── Helpers ──
function ts() { return new Date().toISOString().slice(11, 19); }
function log(m) { console.error(`[${ts()}] ${m}`); }
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function parseDate(s) { if (!s) return null; const d = new Date(s.length === 7 ? s + '-01' : s); return isNaN(d) ? null : d; }
function within2Yr(dateStr) { const d = parseDate(dateStr); return !d || d >= cutoff; }
function daysBetween(d1, d2) { return Math.floor((d2 - d1) / (86400000)); }

// ── Load scenario ──
const scenarioName = process.argv[2] || 'nitrosamine';
const scenarioDir = path.join(WS, 'scenarios', scenarioName);
if (!fs.existsSync(path.join(scenarioDir, 'scenario.json'))) {
  log(`ERROR: 场景不存在: scenarios/${scenarioName}/scenario.json`);
  process.exit(1);
}
const scenarioConfig = JSON.parse(fs.readFileSync(path.join(scenarioDir, 'scenario.json'), 'utf8'));
const scenarioHooks = require(path.join(scenarioDir, 'enrich.js'));
const scenario = { name: scenarioName, dir: scenarioDir, config: scenarioConfig, hooks: scenarioHooks };

const FDA_FILE = path.join(WS, scenarioConfig.cache_file);
const sources = require(path.join(__dirname, 'lib/sources.js'));
const snapshotLib = require(path.join(__dirname, 'lib/snapshot.js'));
const reportLib = require(path.join(__dirname, 'lib/report.js'));

let fda;
function loadFDA() { return JSON.parse(fs.readFileSync(FDA_FILE, 'utf8')); }
function saveFDA() { fs.writeFileSync(FDA_FILE, JSON.stringify(fda, null, 2)); }

// ══════════════════════════════════════════════════
// Phase 0: FDA 列表年龄检查
// ══════════════════════════════════════════════════
function phase0_checkFDAAge() {
  log('═══ Phase 0: FDA 列表检查 ═══');

  const versionField = scenarioConfig.cache_version_field;
  const versionStr = fda[versionField] || '';
  const versionDate = parseDate(versionStr);

  if (versionDate) {
    const ageDays = daysBetween(versionDate, today);
    if (ageDays > FDA_REFRESH_DAYS) {
      log(`⚠️ FDA 列表已 ${ageDays} 天未更新（版本: ${versionStr}）`);
      log(`   建议: 重新运行 ${scenarioName} 场景的 Phase 1 数据采集`);
      log(`   参考: scenarios/${scenarioName}/SKILL.md`);
      log(`   本次运行将使用旧列表继续搜索`);
      return { ageDays, stale: true };
    } else {
      log(`FDA 列表版本: ${versionStr} (${ageDays} 天前更新) ✅`);
      return { ageDays, stale: false };
    }
  } else {
    log(`FDA 列表版本: ${versionStr || 'unknown'}`);
    return { ageDays: -1, stale: false };
  }
}

// ══════════════════════════════════════════════════
// Phase 1: 缓存数据检查
// ══════════════════════════════════════════════════
function phase1_checkFDA() {
  log('═══ Phase 1: 缓存数据检查 ═══');
  if (!fs.existsSync(FDA_FILE)) {
    log(`ERROR: ${scenarioConfig.cache_file} 不存在！`);
    log(`请先手动执行 ${scenarioName} 场景的 Phase 1 数据采集（见 scenarios/${scenarioName}/SKILL.md），然后重新运行 pipeline。`);
    process.exit(1);
  }
  fda = loadFDA();
  const total = Object.keys(fda.apis).length;
  const versionField = scenarioConfig.cache_version_field;
  log(`缓存已加载: ${total} 个 API, 版本: ${fda[versionField] || 'unknown'} (${scenarioConfig.cache_file})`);
  return total;
}


// ══════════════════════════════════════════════════
// 一次性迁移: CDT phase 数据回填
// ══════════════════════════════════════════════════
// 旧版 mapTrial 未映射 CDT trialPhase 字段，导致缓存中 CDT 商机的
// phase 为空。此迁移从已有的 trialType 字段推断 phase。
function migrate_cdtPhaseData() {
  let migrated = 0;
  for (const api of Object.values(fda.apis)) {
    for (const t of (api.results || [])) {
      if (t.source !== 'CDT') continue;
      if (t.phase && t.phase.trim()) continue;
      const tt = t.trialType || '';
      if (/生物等效|生物利用度|BE/.test(tt)) {
        t.phase = '其他-BE';
        migrated++;
      }
    }
  }
  if (migrated > 0) {
    saveFDA();
    log(`📋 迁移: 回填 ${migrated} 条 CDT 商机的 phase 字段 (从 trialType 推断)`);
  }
}

// ══════════════════════════════════════════════════
// Phase 2a: CT.gov REST API 搜索
// ══════════════════════════════════════════════════
async function phase2a_ctgov(allApis, isFull) {
  log('');
  log('═══ Phase 2a: CT.gov REST API 搜索 ═══');
  log(`API 总数: ${allApis.length} | 模式: ${isFull ? '🔄 全量' : '📈 增量（对比缓存检测新增）'}`);
  log(`中国过滤: 仅保留 location.country=China 的试验`);
  log(`日期过滤: >= ${cutoff.toISOString().slice(0, 10)} (2年)`);

  if (isFull) {
    Object.values(fda.apis).forEach(api => {
      api.results = (api.results || []).filter(r => r.source === 'CDT');
      api.lead_count = api.results.length;
    });
    saveFDA();
    log('已清除所有 API 的 CT.gov 缓存数据');
  }

  let done = 0, totalStudies = 0, totalNew = 0, withContact = 0, withDrugName = 0, withForm = 0, errors = 0;
  let unchangedApis = 0;
  const t0 = Date.now();

  for (let i = 0; i < allApis.length; i++) {
    const name = allApis[i];
    const api = fda.apis[name];
    if (!api) continue;

    try {
      const result = await sources.ctgovFetch(name);
      const allTrials = sources.ctgovToTrials(result, name);
      const filtered = allTrials.filter(t => within2Yr(t.regDate));

      // 增量检测: 对比新拉取的 NCT ID 与缓存中的 NCT ID
      const existingCDT = (api.results || []).filter(r => r.source === 'CDT');
      const existingCTGov = (api.results || []).filter(r => r.source === 'CT.gov');
      const existingNctIds = new Set(existingCTGov.map(r => r.regNo));

      const newTrials = filtered.filter(t => !existingNctIds.has(t.regNo));
      const updatedOrSame = filtered.filter(t => existingNctIds.has(t.regNo));

      if (newTrials.length === 0 && existingCTGov.length === filtered.length) {
        // 完全无变化
        unchangedApis++;
        done++;
        if (done % 50 === 0) {
          log(`  ── CT.gov 进度: ${done}/${allApis.length}, ${totalStudies} studies, ${unchangedApis} 无变化 ──`);
        }
        await new Promise(r => setTimeout(r, 200));
        continue;
      }

      // 合并: 用新的替换旧的 CT.gov 数据，保留 CDT
      api.results = existingCDT.concat(filtered);
      api.lead_count = api.results.length;

      totalStudies += filtered.length;
      totalNew += newTrials.length;
      withContact += filtered.filter(t => t.contactPhone || t.contactEmail).length;
      withDrugName += filtered.filter(t => t.drugName).length;
      withForm += filtered.filter(t => t.dosageForm).length;

      if (newTrials.length > 0 || i % 25 === 0) {
        const newInfo = newTrials.length > 0 ? ` (+${newTrials.length}新)` : '';
        log(`  [${i + 1}] ${name}: ${result.totalCount}→${allTrials.length}(中国)→${filtered.length}(2年)${newInfo} [联系:${withContact}]`);
      }
    } catch (e) {
      fs.appendFileSync(ERR_LOG, `[${new Date().toISOString()}] [CT.gov] ${name}: ${e.message.substring(0, 200)}\n`);
      errors++;
      if (errors <= 5) log(`  ✗ ${name}: ${e.message.substring(0, 100)}`);
    }

    done++;
    if (done % 25 === 0) {
      saveFDA();
      const elapsed = ((Date.now() - t0) / 60000).toFixed(1);
      log(`  ── CT.gov 进度: ${done}/${allApis.length}, ${totalStudies} studies, ${unchangedApis} 无变化, ${errors} errors, ${elapsed}min ──`);
    }
    await new Promise(r => setTimeout(r, CTGOV_DELAY_MS));
  }

  saveFDA();
  log(`CT.gov 完成: ${done} APIs, ${totalStudies} 中国试验, ${unchangedApis} 无变化, ${totalNew} 新增, 产品名:${withDrugName} 剂型:${withForm} 联系:${withContact}, 错误:${errors}`);
  return { done, totalStudies, totalNew, errors, unchangedApis };
}

// ══════════════════════════════════════════════════
// Phase 2b: CDT 浏览器搜索 (并发 worker + 持久连接)
// ══════════════════════════════════════════════════
async function phase2b_cdt(allApis, isFull) {
  log('');
  log('═══ Phase 2b: CDT 浏览器搜索 (并发 worker) ═══');

  const cdtSearchLib = require(CDT_SEARCH_LIB);

  // ── 启动前清洗：移除缓存中任何年份不符的 CDT 结果（防御污染） ──
  const minYear = cutoff.getFullYear();
  let sanitized = 0, sanitizedApis = 0;
  Object.entries(fda.apis).forEach(([name, api]) => {
    const before = (api.results || []).length;
    const cleaned = (api.results || []).filter(r => {
      if (r.source !== 'CDT') return true;
      const m = r.regNo.match(/CTR(\d{4})/i);
      if (!m) return true;
      return parseInt(m[1]) >= minYear;
    });
    if (cleaned.length < before) {
      api.results = cleaned;
      api.lead_count = cleaned.length;
      sanitized += (before - cleaned.length);
      sanitizedApis++;
    }
  });
  if (sanitized > 0) {
    Object.entries(fda.apis).forEach(([name, api]) => {
      const cdtResults = (api.results || []).filter(r => r.source === 'CDT');
      if (cdtResults.length === 0 && api.name_cn) {
        api.last_cdt_regno = '';
      }
    });
    saveFDA();
    log(`⚠️ 缓存清洗: 移除 ${sanitized} 条年份<${minYear}的旧 CDT 数据（涉及 ${sanitizedApis} 个 API）`);
  } else {
    log(`✅ 缓存清洗: 所有 CDT 结果均 >= ${minYear}`);
  }

  if (isFull) {
    Object.values(fda.apis).forEach(api => {
      api.last_cdt_regno = '';
      api.results = (api.results || []).filter(r => r.source !== 'CDT');
      api.lead_count = api.results.length;
    });
    saveFDA();
    log('已重置所有 API 的 CDT 游标');
  }

  // 统计增量 vs 全量
  let hasCursor = 0, freshSearch = 0, noChinese = 0;
  allApis.forEach(name => {
    const api = fda.apis[name];
    if (!api.name_cn) { noChinese++; return; }
    if (api.last_cdt_regno) hasCursor++; else freshSearch++;
  });
  log(`API 总数: ${allApis.length} | Worker 数: ${CDT_WORKER_COUNT} | 模式: ${isFull ? '🔄 全量（重置游标）' : '📈 增量（regNo 游标）'}`);
  log(`年份过滤: >= ${minYear} | 有游标: ${hasCursor} | 首次: ${freshSearch} | 无中文名: ${noChinese}`);

  // ── 创建持久浏览器 worker ──
  log('正在创建持久浏览器连接...');
  const browsers = [];
  for (let w = 0; w < CDT_WORKER_COUNT; w++) {
    try {
      if (w > 0) await new Promise(r => setTimeout(r, 2000)); // 错开连接，避免压坱 browserless
      const b = await cdtSearchLib.connectBrowser();
      browsers.push(b);
    } catch (e) {
      log(`⚠️ Worker ${w + 1} 创建失败: ${e.message.substring(0, 100)}，使用 ${w} 个 worker 继续`);
      break;
    }
  }
  const workerCount = browsers.length;
  if (workerCount === 0) {
    log('❌ 无法创建任何浏览器连接，CDT 搜索中止');
    return { done: 0, totalTrials: 0, errors: allApis.length, skippedNoNew: 0 };
  }
  log(`✅ 已创建 ${workerCount} 个持久浏览器连接`);

  // ── 分配 API 到 workers ──
  const workerApis = Array.from({ length: workerCount }, () => []);
  let idx = 0;
  for (const name of allApis) {
    workerApis[idx % workerCount].push(name);
    idx++;
  }
  for (let w = 0; w < workerCount; w++) {
    log(`  Worker ${w + 1}: ${workerApis[w].length} APIs`);
  }

  // ── 并发进度计数器 (Node.js 单线程, ++ 安全) ──
  let done = 0, totalNewTrials = 0, withContact = 0, errors = 0, skippedNoNew = 0;
  const t0cdt = Date.now();

  // ── 重连浏览器 ──
  async function reconnectBrowser(workerId) {
    const prefix = `[W${workerId}]`;
    const oldB = browsers[workerId - 1];
    try { await oldB.close(); } catch (_) {}
    log(`  ${prefix} 🔌 断开旧连接, 重连中...`);
    await new Promise(r => setTimeout(r, 3000 + Math.random() * 3000));
    const newB = await cdtSearchLib.connectBrowser();
    browsers[workerId - 1] = newB;
    return newB;
  }

  // ── 处理搜索结果 → 合并到缓存 ──
  function mergeResults(api, cdtTrials, newCursor, minYear) {
    const existingNonCDT = (api.results || []).filter(r => r.source !== 'CDT');
    const existingCDT = (api.results || []).filter(r => r.source === 'CDT');
    const existingRegNos = new Set(existingCDT.map(r => r.regNo));
    const newTrials = cdtTrials.filter(t => !existingRegNos.has(t.regNo));

    api.results = existingNonCDT.concat(existingCDT, newTrials);
    api.lead_count = api.results.length;

    if (newCursor && newCursor > (api.last_cdt_regno || '')) {
      api.last_cdt_regno = newCursor;
    }

    return newTrials;
  }

  // ── 主动重连周期 (每 25 个 API 断开重连，强制 Browserless 回收内存) ──
  const RECONNECT_EVERY = 25;

  // ── Worker 函数 ──
  async function runWorker(workerId, apiList, browser) {
    const prefix = `[W${workerId}]`;
    let apisSinceConnect = 0;

    for (const name of apiList) {
      const api = fda.apis[name];
      const nameCN = api.name_cn;
      if (!nameCN) {
        log(`  ${prefix} ${name}: 无中文名，跳过`);
        done++;
        continue;
      }

      const cursor = api.last_cdt_regno || '';
      const apiT0 = Date.now();

      // ── 主动重连: 每 N 个 API 断开重连，回收 Browserless 内存 ──
      if (apisSinceConnect >= RECONNECT_EVERY) {
        browser = await reconnectBrowser(workerId);
        apisSinceConnect = 0;
      }

      // ── 被动检查: 浏览器连接是否还活着 ──
      if (browser.isConnected && !browser.isConnected()) {
        log(`  ${prefix} ⚠️ 浏览器已断连 (被动检测): ${name}, 重连中...`);
        browser = await reconnectBrowser(workerId);
        apisSinceConnect = 0;
      }

      try {
        const result = await sources.cdtSearchOneAPI(browser, nameCN, {
          maxPages: 5, minYear, batchSize: 50, cursor, logPrefix: prefix
        });
        apisSinceConnect++;

        const { trials: cdtTrials, totalResults, filteredTotal, filterStats, newCursor } = result;

        // 二次校验告警
        const oldRegNos = cdtTrials.filter(t => {
          const m = t.regNo.match(/CTR(\d{4})/i);
          return m && parseInt(m[1]) < minYear;
        });
        if (oldRegNos.length > 0) {
          const samples = oldRegNos.slice(0, 3).map(t => t.regNo).join(', ');
          log(`  ${prefix} ⚠️ ${name}(${nameCN}): ${oldRegNos.length} 条旧数据! [${samples}]`);
          fs.appendFileSync(ERR_LOG, `[${new Date().toISOString()}] [CDT-VALIDATE] ${name}(${nameCN}): ${oldRegNos.length} old regNos\n`);
        }

        if (cursor && cdtTrials.length === 0) {
          skippedNoNew++;
        } else {
          const newTrials = mergeResults(api, cdtTrials, newCursor, minYear);
          totalNewTrials += newTrials.length;
          const ct = newTrials.filter(t => t.contactPhone || t.contactEmail).length;
          withContact += ct;

          const apiSecs = ((Date.now() - apiT0) / 1000).toFixed(0);
          const cursorInfo = cursor ? ` (cursor)` : '';
          const filterInfo = filterStats && filterStats.filterLog
            ? ` (${filterStats.filterLog.before}→${filterStats.filterLog.after})`
            : '';
          log(`  ${prefix} ${name}(${nameCN}): ${totalResults}${filterInfo}→+${newTrials.length}${cursorInfo} [联系:${ct}] ${apiSecs}s`);
        }
      } catch (e) {
        const isDisconnect = cdtSearchLib.isBrowserDeadError
          ? cdtSearchLib.isBrowserDeadError(e)
          : /disconnect|closed|Target closed|connection|BROWSER_DISCONNECTED/i.test(e.message);

        if (isDisconnect) {
          // ── 浏览器断连 → 重连 + 重试一次 ──
          log(`  ${prefix} ⚠️ 浏览器断连: ${name}(${nameCN}), 重连重试...`);
          try {
            browser = await reconnectBrowser(workerId);
            apisSinceConnect = 0;

            const retryResult = await sources.cdtSearchOneAPI(browser, nameCN, {
              maxPages: 5, minYear, batchSize: 50, cursor, logPrefix: prefix
            });
            apisSinceConnect++;

            const { trials: rt, newCursor: nc2 } = retryResult;
            if (!(cursor && rt.length === 0)) {
              const newTrials = mergeResults(api, rt, nc2, minYear);
              totalNewTrials += newTrials.length;
              withContact += newTrials.filter(t => t.contactPhone || t.contactEmail).length;
            }
            log(`  ${prefix} ${name}(${nameCN}): 重连后成功 ✅`);
          } catch (re) {
            errors++;
            fs.appendFileSync(ERR_LOG, `[${new Date().toISOString()}] [CDT-RECONNECT-FAIL] ${name}(${nameCN}): ${re.message.substring(0, 200)}\n`);
            log(`  ${prefix} ✗ ${name}: 重连失败: ${re.message.substring(0, 100)}`);
          }
        } else {
          errors++;
          apisSinceConnect++;
          fs.appendFileSync(ERR_LOG, `[${new Date().toISOString()}] [CDT] ${name}(${nameCN}): ${e.message.substring(0, 200)}\n`);
          if (errors <= 10) log(`  ${prefix} ✗ ${name}: ${e.message.substring(0, 100)}`);
        }
      }

      done++;

      // 每 10 个 API 保存一次缓存
      if (done % 10 === 0) {
        saveFDA();
        const elapsed = ((Date.now() - t0cdt) / 60000).toFixed(1);
        const rate = done / (elapsed || 1);
        const remaining = ((allApis.length - done) / rate).toFixed(0);
        log(`  ── CDT 进度: ${done}/${allApis.length}, ${totalNewTrials} new, ${skippedNoNew} 无新增, ${errors} errors, ${elapsed}min, ~${remaining}min 剩余 ──`);
      }

      // API 间延迟
      await new Promise(r => setTimeout(r,
        CDT_DELAY_RANGE[0] + Math.random() * (CDT_DELAY_RANGE[1] - CDT_DELAY_RANGE[0])
      ));
    }
  }

  // ── 启动所有 worker (错开 3s 避免同时发请求) ──
  const workerPromises = [];
  for (let w = 0; w < workerCount; w++) {
    workerPromises.push(
      (async (delay) => {
        if (delay > 0) await new Promise(r => setTimeout(r, delay));
        return runWorker(w + 1, workerApis[w], browsers[w]);
      })(w * 3000)
    );
  }
  await Promise.all(workerPromises);

  // ── 清理浏览器 ──
  for (let w = 0; w < workerCount; w++) {
    try { await browsers[w].close(); } catch (_) {}
  }

  saveFDA();
  log(`CDT 完成: ${done} APIs, ${totalNewTrials} new trials, ${skippedNoNew} 无新增, ${withContact} contacts, ${errors} errors`);
  return { done, totalTrials: totalNewTrials, errors, skippedNoNew };
}

// ══════════════════════════════════════════════════
// Phase 3: 快照 + 报告
// ══════════════════════════════════════════════════
function phase3_report(isFull) {
  log('');
  log('═══ Phase 3: 生成快照和报告 ═══');

  fda = loadFDA();

  // ── 增量检测：加载前次快照，对比确定 isNew ──
  const { prevResults, prevSnapFile } = snapshotLib.loadPrevResults(RUNS_DIR, todayStr);
  if (prevSnapFile) {
    log(`前次快照: ${prevSnapFile} (${Object.keys(prevResults).length} APIs)`);
  } else {
    log(`无前次快照，本次为首次运行，不标记新增`);
  }

  const { results, totalLeads, newCount, hasPrevSnap } = snapshotLib.buildResults(fda, prevResults);
  if (hasPrevSnap) {
    log(`增量检测: ${totalLeads} 条商机中 ${newCount} 条为新增（对比前次快照）`);
  }

  const { snapshot, snapFile } = snapshotLib.saveSnapshot({
    fda, results, totalLeads, todayStr, runsDir: RUNS_DIR,
    cacheVersionField: scenarioConfig.cache_version_field,
    scenarioHooks
  });
  log(`快照已保存: ${snapFile}`);

  try {
    const r = reportLib.generateReport(snapshot, scenario, isFull);
    log(`报告已生成: ${r.outputPath}`);
    log(`统计: ${r.totalLeads} leads, ${r.totalNewLeads} new, ${r.apisWithLeadsCount} APIs with leads`);
  } catch (e) {
    log(`报告生成失败: ${e.message}`);
    if (e.stack) log(e.stack.substring(0, 500));
  }
}

// ══════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════
async function main() {
  const t0 = Date.now();
  ensureDir(RUNS_DIR);
  // 每次运行清空 errors.log，避免跨运行累积
  fs.writeFileSync(ERR_LOG, '');

  log('╔══════════════════════════════════════╗');
  log(`║   CSP Pipeline — 场景: ${scenarioName}`);
  log('╚══════════════════════════════════════╝');
  log(`日期: ${todayStr} | 截止线: ${cutoff.toISOString().slice(0, 10)}`);

  // ── 检查搜索模式 ──
  let searchConfig;
  try {
    searchConfig = JSON.parse(fs.readFileSync(SEARCH_CONFIG, 'utf8'));
  } catch {
    searchConfig = { search_mode: 'incremental' };
  }
  const isFull = searchConfig.search_mode === 'full';
  log(`搜索模式: ${isFull ? '🔄 全量（full, 重置游标）' : '📈 增量（incremental, 游标续搜）'}`);

  // ── Phase 1: 缓存数据 ──
  phase1_checkFDA();

  // ── 一次性迁移: CDT phase 数据回填 ──
  migrate_cdtPhaseData();

  // ── Phase 0: FDA 列表年龄 ──
  const fdaStatus = phase0_checkFDAAge();

  // ── 所有 API 都参与搜索 ──
  const allApis = Object.keys(fda.apis);

  // ── Phase 2a: CT.gov（所有 API，增量用 lastUpdate） ──
  const ctgovStats = await phase2a_ctgov(allApis, isFull);

  // ── Phase 2b: CDT（所有 API，增量用 regNo 游标，并发 worker） ──
  const cdtStats = await phase2b_cdt(allApis, isFull);

  // ── Phase 3: 快照 + 报告 ──
  phase3_report(isFull);

  // ── 全量模式自动切回增量 ──
  if (isFull) {
    searchConfig.search_mode = 'incremental';
    fs.writeFileSync(SEARCH_CONFIG, JSON.stringify(searchConfig, null, 2));
    log('全量搜索完成，已将 search_mode 改回 incremental');
  }

  // ── FDA 列表过期提醒 ──
  if (fdaStatus.stale) {
    log('');
    log(`⚠️ 提醒: FDA 列表已 ${fdaStatus.ageDays} 天未更新，建议刷新`);
  }

  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  log('');
  log('╔══════════════════════════════════════╗');
  log(`║ Pipeline 完成! 总耗时: ${mins} 分钟`);
  log(`║ CT.gov: ${ctgovStats.done} APIs, ${ctgovStats.totalStudies} fetched, ${ctgovStats.unchangedApis} 无变化, ${ctgovStats.totalNew || 0} 新增, ${ctgovStats.errors} errors`);
  log(`║ CDT:    ${cdtStats.done} APIs, ${cdtStats.totalTrials} new, ${cdtStats.skippedNoNew} 无新增, ${cdtStats.errors} errors`);
  log(`║ 报告: ${scenarioConfig.report_file}`);
  log('╚══════════════════════════════════════╝');
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
