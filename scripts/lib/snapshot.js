/**
 * 快照 + 增量检测模块（场景无关）
 *
 * 职责：
 *   - 加载前次快照，构建 trial 唯一键集合
 *   - 从 fda 缓存构建本次 results，标记 isNew
 *   - 组装并写入快照文件 output/runs/YYYY-MM-DD.json
 *
 * 场景专属的快照字段（如 nitrosamines 计数）通过 scenarioHooks.snapshotExtras 注入。
 */

const fs = require('fs');
const path = require('path');

// ── Trial 唯一键（用于增量对比） ──
function trialKey(t) {
  return `${t.source}|${t.regNo}`;
}

// ── 加载前次快照的 results（用于增量对比） ──
// 返回 { prevResults, prevSnapFile, prevSnapPath }；无前次快照则 prevResults={}
function loadPrevResults(runsDir, todayStr) {
  const snapFiles = fs.readdirSync(runsDir)
    .filter(f => f.endsWith('.json') && f !== todayStr + '.json')
    .sort().reverse();
  if (snapFiles.length === 0) {
    return { prevResults: {}, prevSnapFile: null, prevSnapPath: null };
  }
  const prevSnapFile = snapFiles[0];
  const prevSnapPath = path.join(runsDir, prevSnapFile);
  try {
    const prevSnap = JSON.parse(fs.readFileSync(prevSnapPath, 'utf8'));
    const prevResults = prevSnap.trials_data ? prevSnap.trials_data.results : {};
    return { prevResults, prevSnapFile, prevSnapPath };
  } catch (e) {
    return { prevResults: {}, prevSnapFile: null, prevSnapPath: null };
  }
}

// ── 构建本次 results + isNew 标记 ──
// fda: 缓存对象 { apis: { name: { results: [...] } } }
// 返回 { results, totalLeads, newCount, hasPrevSnap }
function buildResults(fda, prevResults) {
  const prevKeySet = new Set();
  Object.values(prevResults).forEach(trials => {
    (trials || []).forEach(t => prevKeySet.add(trialKey(t)));
  });

  const results = {};
  let totalLeads = 0;
  let newCount = 0;
  const hasPrevSnap = prevKeySet.size > 0;

  Object.entries(fda.apis).forEach(([name, api]) => {
    if ((api.results || []).length > 0) {
      results[name] = api.results.map(t => {
        // 无前次快照时不标 isNew（全量从0开始，全部都是"新增"无意义）
        const isNew = hasPrevSnap ? !prevKeySet.has(trialKey(t)) : false;
        if (isNew) newCount++;
        return { ...t, isNew };
      });
      totalLeads += api.results.length;
    }
  });

  return { results, totalLeads, newCount, hasPrevSnap };
}

// ── 搜索进度统计 ──
function searchProgress(apis) {
  const all = Object.values(apis);
  const hasCtgov = a => (a.results || []).some(r => r.source === 'CT.gov');
  const hasCdt = a => (a.results || []).some(r => r.source === 'CDT');
  const noCn = a => !a.name_cn;
  return {
    total: all.length,
    ctgov_done: all.filter(a => hasCtgov(a) || (a.results || []).length > 0).length,
    cdt_done: all.filter(a => hasCdt(a) || noCn(a) || (a.results || []).length > 0).length,
    both_done: all.filter(a =>
      (hasCtgov(a) || (a.results || []).length > 0) &&
      (hasCdt(a) || noCn(a) || (a.results || []).length > 0)
    ).length
  };
}

// ── 组装并写入快照 ──
// scenarioHooks.snapshotExtras(fda) 可注入场景专属 fda_data 字段
function saveSnapshot({ fda, results, totalLeads, todayStr, runsDir, cacheVersionField, scenarioHooks }) {
  const apiCount = Object.keys(fda.apis).length;
  const apisWithTrials = Object.keys(results).length;

  const fdaData = {
    total_apis: apiCount,
    fda_page_version: fda[cacheVersionField] || 'unknown',
    search_progress: searchProgress(fda.apis)
  };
  if (scenarioHooks && typeof scenarioHooks.snapshotExtras === 'function') {
    Object.assign(fdaData, scenarioHooks.snapshotExtras(fda));
  }

  const snapshot = {
    run_date: todayStr,
    fda_data: fdaData,
    trials_data: {
      total_apis_searched: apiCount,
      total_trials_found: totalLeads,
      apis_with_trials: apisWithTrials,
      results
    }
  };

  const snapFile = path.join(runsDir, todayStr + '.json');
  fs.writeFileSync(snapFile, JSON.stringify(snapshot, null, 2));
  return { snapshot, snapFile };
}

module.exports = {
  trialKey,
  loadPrevResults,
  buildResults,
  searchProgress,
  saveSnapshot
};
