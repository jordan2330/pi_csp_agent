#!/usr/bin/env node
/**
 * v2 周报生成（M2）— trial 粒度、从 DB 直接查询
 *
 * 锁定口径（docs/v2-requirements.md 附录 G）:
 *  ① 报全部新增 trial（first_seen_at > 上次报告），毙掉不过滤，加 ⚰️ 标记
 *  ② trial 粒度、按 API 分组，不按 email 聚合
 *  ③ 无 email 照常进周报
 *  ④ 只管生成 MD 文件，发送由外部脚本负责
 *
 * 新鲜度（验收 #13）: 报告头声明 ctgov_as_of / cdt_as_of
 *   + 若 meta.cdt_last_error 存在 → 明示 "CDT 本轮未更新，数据截至 <as_of>"
 *
 * 用法: node scripts/v2/report.js [--db config/csp.db] [--out output/CSP_Leads_Report.md]
 *
 * 首期（无 report_as_of 基线）= 全量市场地图（引导期）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const [k, inlineV] = argv[i].slice(2).split('=');
    const v = inlineV !== undefined ? inlineV
      : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
    out[k] = v;
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));
const DB_PATH = ARGS.db || path.join(ROOT, 'config', 'csp.db');
const OUT_PATH = ARGS.out || path.join(ROOT, 'output', 'CSP_Leads_Report.md');

const COLUMNS = [
  ['申请人', 'sponsor'], ['产品名称', 'drug_name'], ['剂型', 'dosageForm'],
  ['状态', 'status'], ['适应症', 'condition'], ['分期', 'phase'], ['登记日期', 'regDate'],
  ['联系人', 'contactName'], ['邮箱', 'contactEmail'], ['来源', 'source'], ['毙掉', 'killedMark']
];

// 验收 #7: 单元格转义 | 和换行
function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function renderRow(r) {
  return '| ' + COLUMNS.map(([, k]) => esc(r[k])).join(' | ') + ' |';
}

function metaValue(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key=?').get(key);
  return row ? row.value : null;
}

function generateReport(db, outPath) {
  const reportAsOf = metaValue(db, 'report_as_of');
  const isFirst = !reportAsOf;
  const ctgovAsOf = metaValue(db, 'ctgov_as_of');
  const cdtAsOf = metaValue(db, 'cdt_as_of');
  const cdtErr = metaValue(db, 'cdt_last_error');
  const now = new Date().toISOString();
  const todayZh = new Date().toISOString().slice(0, 10);

  const newTrials = reportAsOf
    ? db.prepare(`SELECT t.*, a.api, a.drug_name FROM trial_apis a JOIN trials t
                  ON t.source=a.trial_source AND t.regNo=a.trial_regNo
                  WHERE t.first_seen_at > ? ORDER BY a.api, t.regDate DESC`)
      .all(reportAsOf)
    : db.prepare(`SELECT t.*, a.api, a.drug_name FROM trial_apis a JOIN trials t
                  ON t.source=a.trial_source AND t.regNo=a.trial_regNo
                  ORDER BY a.api, t.regDate DESC`).all();

  // 按 API 分组
  const byApi = new Map();
  for (const r of newTrials) {
    if (!byApi.has(r.api)) byApi.set(r.api, []);
    byApi.get(r.api).push(r);
  }

  const apiCN = new Map(db.prepare('SELECT en_name, cn_name FROM fda_apis').all()
    .map(r => [r.en_name, r.cn_name]));

  const md = [];
  md.push('# CSP 商机周报');
  md.push('');
  md.push(`> 生成时间: ${todayZh}${isFirst ? '　**首期（全量市场地图）**' : ''}`);
  md.push('');
  md.push('## 数据新鲜度');
  md.push('');
  md.push(`- CT.gov 数据截至: ${ctgovAsOf || '从未成功采集 ⚠️'}`);
  const cdtLine = cdtAsOf
    ? `- CDT 数据截至: ${cdtAsOf}${cdtErr ? '　⚠️ 本轮 CDT 采集失败（未更新）' : ''}`
    : '- CDT 数据: 从未成功采集 ⚠️';
  md.push(cdtLine);
  md.push('');

  const killedCount = newTrials.filter(r => r.killed_at).length;
  const stat = {
    total: newTrials.length, apis: byApi.size,
    killed: killedCount,
    ctgov: newTrials.filter(r => r.source === 'CT.gov').length,
    cdt: newTrials.filter(r => r.source === 'CDT').length,
    noEmail: newTrials.filter(r => !r.contactEmail).length
  };
  md.push(`## ${isFirst ? '全部' : '本周新增'}商机摘要`);
  md.push('');
  md.push(`- 试验条目: **${stat.total}**（CT.gov ${stat.ctgov} / CDT ${stat.cdt}） | 涉及 API: ${stat.apis}`);
  md.push(`- 已毙掉(不导出但供市场视野): ${stat.killed} | 无邮箱(照常展示): ${stat.noEmail}`);
  md.push('');
  md.push('> 毙掉标记 ⚰️ = BD 已在审核台标记无希望；周报为市场视野，不因毙掉过滤。');
  md.push('---');
  md.push('');

  if (newTrials.length === 0) {
    md.push('*本周无新增试验。*');
  }

  for (const [api, rows] of [...byApi.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const cn = apiCN.get(api) || '';
    md.push(`## ${cn ? cn + ' ' : ''}${api} — ${rows.length} 条试验`);
    md.push('');
    md.push('| ' + COLUMNS.map(([h]) => h).join(' | ') + ' |');
    md.push('|' + COLUMNS.map(() => '---').join('|') + '|');
    for (const r of rows) {
      md.push(renderRow({ ...r, killedMark: r.killed_at ? '⚰️' : '' }));
    }
    md.push('');
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, md.join('\n'));
  return { stat, path: outPath, isFirst };
}

// 基线推进：先生成成功后才推进（失败不得推进）
function advanceBaseline(db, ts = new Date().toISOString()) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run('report_as_of', ts);
}

module.exports = { generateReport, advanceBaseline, esc };

if (require.main === module) {
  const { openDB } = require('./db');
  const db = openDB(DB_PATH);
  const { stat, path: p, isFirst } = generateReport(db, OUT_PATH);
  advanceBaseline(db);
  console.log(`周报已生成: ${p}`);
  console.log(`  条目 ${stat.total} | API ${stat.apis} | ⚰️ ${stat.killed} | 无邮箱 ${stat.noEmail}${isFirst ? ' | 首期全量' : ''}`);
}