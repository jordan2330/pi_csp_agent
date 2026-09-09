/**
 * SF 导出（M4）— email 聚合行 → SF Import Template 16 列
 *
 * 锁定决策（附录 D/E/G）:
 *  - 导出行 = 唯一 email；已导出(email 在 exported_emails)不再导出
 *  - 毙掉的 trial 不参与聚合；email 下全部被毙 → 整行不出
 *  - Company/姓名/电话 = 该 email 下 regDate 最新的活 trial
 *  - 姓名拆分: 最后空格拆；中文整名进 Last Name，First Name 填 "."
 *  - picklist 默认值: Lead Source=Self-generated / Prospecting, Region=APAC,
 *    Business Unit=CSP, Lead Status=Needs Outreach（scenario 可覆写）
 *  - Description = 聚合并发试验明细（regNo/产品/申办方/状态/日期）
 *  - 缺 email 的行不导（web 补全后才进候选）
 */
'use strict';

const ExcelJS = require('exceljs');

const COLUMNS = [
  'Campaign ID', 'Business Unit', 'Lead Source', 'Description', 'Lead Owner',
  'Lead Status', 'First Name', 'Last Name', 'Email', 'Company', 'Phone',
  'Mobile', 'Country', 'Region', 'Application Field', 'CSP Lead Owner Comments'
];

function splitName(full) {
  const name = (full || '').trim();
  if (!name) return { first: '.', last: '.' };
  if (/[\u4e00-\u9fff]/.test(name)) return { first: '.', last: name };
  const idx = name.lastIndexOf(' ');
  if (idx > 0) return { first: name.slice(0, idx), last: name.slice(idx + 1) };
  return { first: '.', last: name };
}

// 导出行集合（不放 exported_emails 里）
function exportRows(db, defaults = {}) {
  const emails = db.prepare(`
    SELECT contactEmail AS email FROM trials
    WHERE contactEmail IS NOT NULL AND contactEmail != '' AND killed_at IS NULL
      AND contactEmail NOT IN (SELECT email FROM exported_emails)
    GROUP BY contactEmail`).all().map(r => r.email);
  return emails.map(email => buildRow(db, email, defaults)).filter(Boolean);
}

function buildRow(db, email, defaults = {}) {
  // 过滤被毙 trial
  const rows = db.prepare(`SELECT * FROM trials WHERE contactEmail=? AND killed_at IS NULL ORDER BY regDate DESC`).all(email);
  if (rows.length === 0) return null;
  const latest = rows[0];
  const hasName = rows.filter(r => r.contactName).length > 0;
  const name = (rows.find(r => r.contactName) || latest).contactName || '';
  const { first, last } = splitName(name);
  const phone = (rows.find(r => r.contactPhone) || latest).contactPhone || '';

  const description = rows.map(r =>
    `[${r.regNo}] ${r.drugName || ''}${r.sponsor ? '（' + r.sponsor + '）' : ''} ${r.status || ''} ${(r.regDate || '').slice(0, 10)}`
  ).join('；');

  return {
    'Campaign ID': defaults.campaignId || '',
    'Business Unit': defaults.businessUnit || 'CSP',
    'Lead Source': defaults.leadSource || 'Self-generated / Prospecting',
    'Description': description,
    'Lead Owner': defaults.leadOwner || '',
    'Lead Status': defaults.leadStatus || 'Needs Outreach',
    'First Name': first,
    'Last Name': last,
    'Email': email,
    'Company': latest.sponsor || '',
    'Phone': phone,
    'Mobile': '',
    'Country': defaults.country || 'China',
    'Region': defaults.region || 'APAC',
    'Application Field': defaults.applicationField || '',
    'CSP Lead Owner Comments': defaults.ownerComments || ''
  };
}

// 生成 xlsx buffer；emails 可选（web 反选后只导勾选的）
function buildExcel(db, { emails, defaults } = {}) {
  const rows = emails ? emails.map(e => buildRow(db, e, defaults)).filter(Boolean)
                      : exportRows(db, defaults);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Import Template');
  ws.addRow(COLUMNS);
  ws.getRow(1).font = { bold: true };
  for (const r of rows) ws.addRow(COLUMNS.map(c => r[c] ?? ''));
  return { rows, async buffer() { return await wb.xlsx.writeBuffer(); } };
}

// 标记已导出（导出成功后调用）
function markExported(db, emails) {
  const ins = db.prepare('INSERT OR IGNORE INTO exported_emails (email, exported_at) VALUES (?, ?)');
  db.exec('BEGIN');
  try {
    for (const e of emails) ins.run(e, new Date().toISOString());
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return emails.length;
}

module.exports = { COLUMNS, splitName, exportRows, buildRow, buildExcel, markExported };