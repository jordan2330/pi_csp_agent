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
const CDT_SCRIPT = path.join(WS, 'skills/browser_executor/scripts/cdt-search.js');

const CTGOV_DELAY_MS = 800;
const CDT_DELAY_MS = 3000;
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
// Phase 2b: CDT 浏览器搜索
// ══════════════════════════════════════════════════
function phase2b_cdt(allApis, isFull) {
  log('');
  log('═══ Phase 2b: CDT 浏览器搜索 ═══');

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
    // 被清洗的 API 重置游标，确保重新搜索
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
    // 全量模式: 重置所有 CDT 游标和结果
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
  log(`API 总数: ${allApis.length} | 模式: ${isFull ? '🔄 全量（重置游标）' : '📈 增量（regNo 游标）'}`);
  log(`年份过滤: >= ${minYear} | 有游标: ${hasCursor} | 首次: ${freshSearch} | 无中文名: ${noChinese}`);

  let done = 0, totalNewTrials = 0, withContact = 0, errors = 0;
  let skippedNoNew = 0;  // 增量搜索返回 0 条新数据
  const t0cdt = Date.now();

  for (let i = 0; i < allApis.length; i++) {
    const name = allApis[i];
    const api = fda.apis[name];
    const nameCN = api.name_cn;
    if (!nameCN) {
      log(`  [${i + 1}] ${name}: 无中文名，跳过`);
      done++;
      continue;
    }

    const cursor = api.last_cdt_regno || '';
    const apiT0 = Date.now();

    try {
      const { trials: cdtTrials, totalResults, filteredTotal, filterStats, newCursor } = sources.runCDTSearch(nameCN, CDT_SCRIPT, {
        maxPages: 5, timeout: 1200000, minYear: minYear, batchSize: 50, cursor
      });

      // 二次校验告警
      const oldRegNos = cdtTrials.filter(t => {
        const m = t.regNo.match(/CTR(\d{4})/i);
        return m && parseInt(m[1]) < minYear;
      });
      if (oldRegNos.length > 0) {
        const samples = oldRegNos.slice(0, 3).map(t => t.regNo).join(', ');
        log(`  ⚠️ ${name}(${nameCN}): 二次校验发现 ${oldRegNos.length} 条旧数据! [${samples}]`);
        fs.appendFileSync(ERR_LOG, `[${new Date().toISOString()}] [CDT-VALIDATE] ${name}(${nameCN}): ${oldRegNos.length} old regNos post-filter: ${samples}\n`);
      }

      if (cursor && cdtTrials.length === 0) {
        // 增量搜索无新增 → 跳过
        skippedNoNew++;
        done++;
        if (done % 10 === 0) {
          const elapsed = ((Date.now() - t0cdt) / 60000).toFixed(1);
          log(`  ── CDT 进度: ${done}/${allApis.length}, ${totalNewTrials} new, ${skippedNoNew} 无新增, ${errors} errors, ${elapsed}min ──`);
        }
        if (i < allApis.length - 1) {
          execSync(`sleep ${(CDT_DELAY_MS / 1000).toFixed(1)}`, { stdio: 'pipe' });
        }
        continue;
      }

      // 有新增数据 → 追加到现有结果
      const existingNonCDT = (api.results || []).filter(r => r.source !== 'CDT');
      const existingCDT = (api.results || []).filter(r => r.source === 'CDT');

      // CDT 数据不可变，直接追加（按 regNo 去重保险）
      const existingRegNos = new Set(existingCDT.map(r => r.regNo));
      const newTrials = cdtTrials.filter(t => !existingRegNos.has(t.regNo));

      api.results = existingNonCDT.concat(existingCDT, newTrials);
      api.lead_count = api.results.length;

      // 更新游标
      if (newCursor && newCursor > (api.last_cdt_regno || '')) {
        api.last_cdt_regno = newCursor;
      }

      totalNewTrials += newTrials.length;
      const ct = newTrials.filter(t => t.contactPhone || t.contactEmail).length;
      withContact += ct;

      const apiSecs = ((Date.now() - apiT0) / 1000).toFixed(0);
      if (newTrials.length > 0 || i % 10 === 0) {
        const cursorInfo = cursor ? ` (cursor=${cursor})` : '';
        const filterInfo = filterStats && filterStats.filterLog
          ? ` (${filterStats.filterLog.before}→${filterStats.filterLog.after})`
          : '';
        log(`  [${i + 1}] ${name}(${nameCN}): ${totalResults}${filterInfo}→+${newTrials.length}${cursorInfo} [联系:${ct}] ${apiSecs}s`);
      }
    } catch (e) {
      fs.appendFileSync(ERR_LOG, `[${new Date().toISOString()}] [CDT] ${name}(${nameCN}): ${e.message.substring(0, 200)}\n`);
      errors++;
      if (errors <= 5) log(`  ✗ ${name}: ${e.message.substring(0, 100)}`);
    }

    done++;
    saveFDA();

    if (done % 10 === 0) {
      const elapsed = ((Date.now() - t0cdt) / 60000).toFixed(1);
      const rate = done / (elapsed || 1);
      const remaining = ((allApis.length - done) / rate).toFixed(0);
      log(`  ── CDT 进度: ${done}/${allApis.length}, ${totalNewTrials} new, ${skippedNoNew} 无新增, ${errors} errors, ${elapsed}min, ~${remaining}min 剩余 ──`);
    }

    if (i < allApis.length - 1) {
      const delay = CDT_DELAY_MS + Math.random() * 1000;
      execSync(`sleep ${(delay / 1000).toFixed(1)}`, { stdio: 'pipe' });
    }
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
    const r = reportLib.generateReport(snapshot, scenario);
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

  // ── Phase 0: FDA 列表年龄 ──
  const fdaStatus = phase0_checkFDAAge();

  // ── 所有 API 都参与搜索 ──
  const allApis = Object.keys(fda.apis);

  // ── Phase 2a: CT.gov（所有 API，增量用 lastUpdate） ──
  const ctgovStats = await phase2a_ctgov(allApis, isFull);

  // ── Phase 2b: CDT（所有 API，增量用 regNo 游标） ──
  const cdtStats = phase2b_cdt(allApis, isFull);

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
