#!/usr/bin/env node
/**
 * 一次性迁移脚本：fda_nitrosamines.json → PostgreSQL
 *
 * 用法:
 *   DATABASE_URL=postgresql://csp:csp@localhost:5432/csp node scripts/migrate-to-db.js
 *
 * 幂等：可多次运行，ON CONFLICT DO UPDATE 不重复插入
 *
 * 迁移内容：
 *   1. apis 表 — API 元数据 + metadata（potency_category, ai_limit, nitrosamines）
 *   2. search_state 表 — CDT 游标（last_cdt_regno），CT.gov 无游标
 *   3. trials 表 — 所有 results（双源试验数据）
 *   4. snapshots 表 — 从 output/runs/*.json 导入（如存在）
 */

const fs = require('fs');
const path = require('path');

const WS = process.env.WS || '/workspace';
const FDA_FILE = path.join(WS, 'config/fda_nitrosamines.json');
const RUNS_DIR = path.join(WS, 'output/runs');
const SCENARIO = 'nitrosamine';

function ts() { return new Date().toISOString().slice(11, 19); }
function log(m) { console.log(`[${ts()}] ${m}`); }

async function main() {
  const db = require('./lib/db');
  await db.init();
  log('数据库已连接，schema 已初始化');

  // ── 检查源文件 ──
  if (!fs.existsSync(FDA_FILE)) {
    log(`ERROR: ${FDA_FILE} 不存在，无需迁移`);
    await db.close();
    process.exit(0);
  }

  log('读取 fda_nitrosamines.json ...');
  const fda = JSON.parse(fs.readFileSync(FDA_FILE, 'utf8'));
  const apiNames = Object.keys(fda.apis || {});
  log(`API 总数: ${apiNames.length}`);

  const sourceVersion = fda.fda_page_version || fda.last_updated || 'unknown';
  let totalTrials = 0;
  let totalCursors = 0;

  // ── 1. 迁移 API 元数据 + 搜索状态 + 试验结果 ──
  for (let i = 0; i < apiNames.length; i++) {
    const name = apiNames[i];
    const api = fda.apis[name];
    const idx = i + 1;

    // API 元数据
    const metadata = {};
    if (api.potency_category !== undefined) metadata.potency_category = api.potency_category;
    if (api.ai_limit !== undefined) metadata.ai_limit = api.ai_limit;
    if (api.limit !== undefined) metadata.ai_limit = api.limit; // 兼容旧字段名
    if (api.nitrosamines) metadata.nitrosamines = api.nitrosamines;

    await db.upsertAPI(SCENARIO, {
      name_en: name,
      name_cn: api.name_cn || null,
      metadata,
      source_version: sourceVersion,
      detected_at: api.fda_detected_at || api.last_updated || null
    });

    // 搜索状态 — CDT 游标
    const hasCDTCursor = api.last_cdt_regno && api.last_cdt_regno !== '';
    if (hasCDTCursor) {
      await db.updateSearchState(SCENARIO, name, 'CDT', {
        last_cursor: api.last_cdt_regno,
        lead_count: (api.results || []).filter(r => r.source === 'CDT').length
      });
      totalCursors++;
    } else {
      await db.ensureSearchState(SCENARIO, name, 'CDT');
    }

    // 搜索状态 — CT.gov（无游标，但有搜索记录）
    const hasCTGovResults = (api.results || []).some(r => r.source === 'CT.gov' || r.source === 'CT.gov');
    if (hasCTGovResults) {
      await db.updateSearchState(SCENARIO, name, 'CT.gov', {
        last_cursor: '',
        lead_count: (api.results || []).filter(r => r.source !== 'CDT').length
      });
    } else {
      await db.ensureSearchState(SCENARIO, name, 'CT.gov');
    }

    // 试验结果
    const trials = (api.results || []).map(t => ({
      source: t.source,
      reg_no: t.regNo || '',
      reg_date: t.regDate || '',
      sponsor: t.sponsor || '',
      status: t.status || '',
      drug_name: t.drugName || '',
      dosage_form: t.dosageForm || '',
      drug_classification: t.drugClassification || '',
      trial_type: t.trialType || '',
      contact_name: t.contactName || '',
      contact_phone: t.contactPhone || '',
      contact_email: t.contactEmail || '',
      contact_address: t.contactAddress || '',
      pi_name: t.piName || '',
      pi_unit: t.piUnit || '',
      brief_title: t.briefTitle || '',
      official_title: t.officialTitle || '',
      target_enrollment: t.targetEnrollment || '',
      last_update_date: t.lastUpdateDate || '',
      is_new: t.isNew || false
    }));

    if (trials.length > 0) {
      await db.batchUpsertTrials(SCENARIO, trials);
      totalTrials += trials.length;
    }

    if (idx % 50 === 0) {
      log(`  进度: ${idx}/${apiNames.length}, ${totalTrials} trials, ${totalCursors} cursors`);
    }
  }

  log(`API 迁移完成: ${apiNames.length} APIs, ${totalTrials} trials, ${totalCursors} CDT cursors`);

  // ── 2. 迁移快照 ──
  if (fs.existsSync(RUNS_DIR)) {
    const snapFiles = fs.readdirSync(RUNS_DIR)
      .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.json$/))
      .sort();

    let snapCount = 0;
    for (const file of snapFiles) {
      const runDate = file.replace('.json', '');
      const snapPath = path.join(RUNS_DIR, file);
      try {
        const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
        await db.saveSnapshot(runDate, SCENARIO, snap);
        snapCount++;
      } catch (e) {
        log(`  ⚠ 快照 ${file} 解析失败: ${e.message.substring(0, 100)}`);
      }
    }
    log(`快照迁移完成: ${snapCount} snapshots`);
  }

  // ── 验证 ──
  const apiCount = await db.getAPICount(SCENARIO);
  const trialCount = await db.countTrials(SCENARIO);
  const cdtCount = await db.countTrialsBySource(SCENARIO, 'CDT');
  const ctgovCount = await db.countTrialsBySource(SCENARIO, 'CT.gov');

  log('');
  log('══════════════════════════════════════');
  log('  迁移完成！验证数据:');
  log(`  APIs:        ${apiCount}`);
  log(`  Total trials: ${trialCount}`);
  log(`  CDT trials:  ${cdtCount}`);
  log(`  CT.gov trials: ${ctgovCount}`);
  log('══════════════════════════════════════');

  await db.close();
}

main().catch(e => {
  console.error('FATAL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
