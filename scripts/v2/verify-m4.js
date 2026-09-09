/**
 * M4 导出自检（离线确定）— 16 列模板 / email 聚合 / 姓名拆分 / 毙掉排除 / 增量已导出
 * 用法: node scripts/v2/verify-m4.js
 */
'use strict';

const assert = require('assert');
const { openDB } = require('./db');
const { COLUMNS, splitName, exportRows, buildExcel, markExported } = require('./export');

// ── 姓名拆分 ──
assert.deepStrictEqual(splitName('Zhao-Shen Li'), { first: 'Zhao-Shen', last: 'Li' });
assert.deepStrictEqual(splitName('Fangqiong Li'), { first: 'Fangqiong', last: 'Li' });
assert.deepStrictEqual(splitName('杨彩霞'), { first: '.', last: '杨彩霞' });
assert.deepStrictEqual(splitName(''), { first: '.', last: '.' });
assert.deepStrictEqual(splitName('Cher'), { first: '.', last: 'Cher' });
console.log('PASS ① 姓名拆分（英文最后空格/中文整名进 Last/空名占位）');

const db = openDB(':memory:');
const ins = db.prepare(`INSERT INTO trials
  (source, regNo, sponsor, contactEmail, contactName, contactPhone, regDate, status, first_seen_at, killed_at, kill_reason)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const insApi = db.prepare(`INSERT INTO trial_apis (trial_source, trial_regNo, api, drug_name) VALUES (?, ?, ?, ?)`);
// email a@x.com: 3 条活 + 1 条被毙
ins.run('CT.gov', 'NCT_E1', '公司甲', 'a@x.com', 'Zhao-Shen Li', '13800000000', '2026-08-01', 'RECRUITING', '2026-09-01T00:00:00Z', null, null);
ins.run('CDT', 'CTR_E2', '公司乙', 'a@x.com', 'Zhao-Shen Li', '13900000000', '2026-09-01', '已完成', '2026-09-01T00:00:00Z', null, null);
ins.run('CT.gov', 'NCT_E3', '公司丙', 'a@x.com', '杨彩霞', '13700000000', '2026-08-15', 'COMPLETED', '2026-09-01T00:00:00Z', null, null);
ins.run('CDT', 'CTR_E4', '公司甲', 'a@x.com', 'Zhao-Shen Li', '', '2026-07-01', '已完成', '2026-09-01T00:00:00Z', '2026-09-03T00:00:00Z', '废数据');
// email b@x.com: 全部被毙 → 整行不出
ins.run('CT.gov', 'NCT_E5', '公司丁', 'b@x.com', 'Wang Wu', '', '2026-08-01', 'RECRUITING', '2026-09-01T00:00:00Z', '2026-09-03T00:00:00Z', '废');
// 无 email → 不出
ins.run('CT.gov', 'NCT_E6', '公司戊', null, 'NoMail', '', '2026-08-01', 'RECRUITING', '2026-09-01T00:00:00Z', null, null);

const rows = exportRows(db);
assert.strictEqual(rows.length, 1, `应 1 个可导 email, 实际 ${rows.length}`);
const r = rows[0];
assert.strictEqual(r['Email'], 'a@x.com');
assert.strictEqual(r['Company'], '公司乙', 'Company 应取 regDate 最新 sponsor（CTR_E2 公司乙）');
assert.strictEqual(r['First Name'], 'Zhao-Shen', '姓名应取有联系人名的最新 trial（CTR_E2 Zhao-Shen Li）');
assert.strictEqual(r['Phone'], '13900000000', 'Phone 应取最新有电话的 trial');
assert(!r['Description'].includes('CTR_E4'), '被毙 trial 不应出现在 Description');
assert.match(r['Description'], /CTR_E2/);
assert.strictEqual(r['Lead Status'], 'Needs Outreach');
assert.strictEqual(r['Lead Source'], 'Self-generated / Prospecting');
assert.strictEqual(r['Region'], 'APAC');
assert.strictEqual(r['Business Unit'], 'CSP');
console.log('PASS ② email 聚合（最新 sponsor/姓名/电话、毙掉剔除、全毙整行不出）');

(async () => {
  // xlsx 生成 + 列头
  const { rows: genRows, buffer } = buildExcel(db);
  const buf = await buffer();
  assert(buf.length > 500, 'xlsx buffer 过小');
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet('Import Template');
  assert(ws, '工作表名应为 Import Template');
  const header = ws.getRow(1).values.slice(1);
  assert.deepStrictEqual(header.map(String), COLUMNS, '16 列表头不符');
  assert.strictEqual(ws.actualRowCount, 2, `应表头+1 行, 实际 ${ws.actualRowCount}`);
  console.log('PASS ③ xlsx 16 列模板 + sheet 名');

  // 标记导出 → 增量: 第二遍导出应为空
  markExported(db, genRows.map(x => x['Email']));
  const again = exportRows(db);
  assert.strictEqual(again.length, 0, '已导出 email 不应再出现');
  const mark = db.prepare('SELECT * FROM exported_emails WHERE email=?').get('a@x.com');
  assert(mark && mark.exported_at, 'exported_emails 应记录导出时间');
  console.log('PASS ④ 导出后标记，增量不重导');
  console.log('\nM4 自检 ALL PASS');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });