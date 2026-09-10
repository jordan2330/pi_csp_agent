#!/usr/bin/env node
/**
 * v2 状态重置工具
 *
 * 用法:
 *   node scripts/v2/reset.js what [dbPath]
 *
 * 场景:
 *   cdt      清空全部 CDT 游标（下次采集 = CDT 全量重抓、数据照常 upsert 去重）
 *   ctgov    删除库内全部 CT.gov trial（下次采集 = CT.gov 全量重拉）
 *   report   清掉周报基线（下次周报 = 全量市场地图，而不是增量）
 *   export   清掉已导出 email 记录（下次导出 = 全部 email 重新可导）
 *   everything  清空 trials/trial_apis/exported_emails/meta（FDA/用户保留；周报回报全新一轮 => 首期全量）
 *
 * 首轮采集后一般只需要 cdt（CT.gov 本来每次就是全量拉）。
 */
'use strict';

const path = require('path');
const { openDB } = require('./db');

const what = process.argv[2];
const dbPath = process.argv[3] || path.join(__dirname, '..', '..', 'config', 'csp.db');

if (!what) {
  console.error('用法: node scripts/v2/reset.js cdt|ctgov|report|export|everything [dbPath]');
  process.exit(1);
}

const db = openDB(dbPath);
const tx = fn => { db.exec('BEGIN'); try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } };

switch (what) {
  case 'cdt': {
    const r = db.prepare("DELETE FROM meta WHERE key LIKE 'cdt_cursor:%'").run();
    console.log(`已清空 ${r.changes} 个 CDT 游标。下次 collect 将全量重抓 CDT。`);
    break;
  }
  case 'ctgov': {
    tx(() => {
      db.prepare("DELETE FROM trial_apis WHERE trial_source='CT.gov'").run();
      const r = db.prepare("DELETE FROM trials WHERE source='CT.gov'").run();
      console.log(`已删除 ${r.changes} 条 CT.gov trial。下次 collect 全量重拉。`);
    });
    break;
  }
  case 'report': {
    db.prepare("DELETE FROM meta WHERE key='report_as_of'").run();
    console.log('已清掉周报基线。下次 report.js = 首期全量市场地图（几千行，慎用）。');
    break;
  }
  case 'export': {
    const r = db.prepare('DELETE FROM exported_emails').run();
    console.log(`已清掉 ${r.changes} 条已导出记录。所有 email 重新可导。`);
    break;
  }
  case 'everything': {
    tx(() => {
      for (const t of ['trials', 'trial_apis', 'exported_emails']) db.prepare(`DELETE FROM ${t}`).run();
      db.prepare(`DELETE FROM meta WHERE key NOT IN ('fda_page_version')`).run();
    });
    console.log('已清空 trials/trial_apis/exported/meta（保留 fda_apis/users）。等于从零开始。');
    break;
  }
  default:
    console.error(`未知目标: ${what}（cdt|ctgov|report|export|everything）`);
    process.exit(1);
}