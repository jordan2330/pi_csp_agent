/**
 * M2 周报自检（离线确定）— 口径四条
 * 用法: node scripts/v2/verify-m2.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDB } = require('./db');
const { generateReport, advanceBaseline } = require('./report');

function seed(db) {
  db.prepare('INSERT INTO fda_apis (en_name, cn_name) VALUES (?, ?)').run('Acarbose', '阿卡波糖');
  const rows = [
    [// kill 标记可见
      'CT.gov', 'NCT_A1', 'Acarbose', '苯|甲酸', '2026-09-02T00:00:00Z', 'SponsorX', 'mail1@x.com', '2026-09-03T01:00:00Z'],
    [// 无 email 照常
      'CT.gov', 'NCT_A2', 'Acarbose', '阿卡波糖片', '2026-09-02T00:00:00Z', 'SponsorY', null, null],
    [// 普通
      'CDT', 'CTR2026001', 'Acarbose', '阿卡波糖胶囊', '2026-09-10T00:00:00Z', '某药业', 'm2@x.com', null]
  ];
  const ins = db.prepare(`INSERT INTO trials (source, regNo, sponsor, contactEmail, first_seen_at, killed_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const insApi = db.prepare(`INSERT INTO trial_apis (trial_source, trial_regNo, api, drug_name) VALUES (?, ?, ?, ?)`);
  for (const [src, reg, api, drug, seen, sponsor, email, killed] of rows) {
    ins.run(src, reg, sponsor, email, seen, killed);
    insApi.run(src, reg, api, drug);
  }
}

const tmp = path.join(os.tmpdir(), `m2-report-${Date.now()}.md`);
const db = openDB(':memory:');
seed(db);

// ── 首期 = 全量 ──
const r1 = generateReport(db, tmp);
const md1 = fs.readFileSync(tmp, 'utf8');
assert.strictEqual(r1.isFirst, true, '无基线应为首期');
assert.strictEqual(r1.stat.total, 3, `首期应 3 条, ${r1.stat.total}`);
assert(md1.includes('⚰️'), '毙掉的应可见且有标记');
assert(md1.includes('SponsorY') && md1.includes('阿卡波糖片'), '无 email 应照常进周报');
assert(md1.includes('苯\\|甲酸'), '竖线应被转义');
assert.strictEqual(r1.stat.noEmail, 1);
assert.strictEqual(r1.stat.killed, 1);
advanceBaseline(db, '2026-09-10T12:00:00Z');
console.log('PASS ① 首期全量 + 毙掉/无email/转义');

// ── 二期 = 仅增量 ──
db.prepare(`INSERT INTO trials (source, regNo, sponsor, first_seen_at) VALUES ('CDT', 'CTR2026002', '新药业', '2026-09-11T00:00:00Z')`).run();
db.prepare(`INSERT INTO trial_apis (trial_source, trial_regNo, api, drug_name) VALUES ('CDT', 'CTR2026002', 'Acarbose', '阿卡波糖针')`).run();
const r2 = generateReport(db, tmp);
assert.strictEqual(r2.isFirst, false);
assert.strictEqual(r2.stat.total, 1, `增量应仅 1 条, ${r2.stat.total}`);
const md2 = fs.readFileSync(tmp, 'utf8');
assert(md2.includes('新药业') && !md2.includes('NCT_A1') && !md2.includes('SponsorX'), '增量应只含新 trial');
console.log('PASS ② 增量基线（只报新增）');

// ── 新鲜度标注 ──
db.prepare("INSERT INTO meta (key, value) VALUES ('ctgov_as_of','2026-09-10')").run();
db.prepare("INSERT INTO meta (key, value) VALUES ('cdt_as_of','2026-09-08')").run();
db.prepare("INSERT INTO meta (key, value) VALUES ('cdt_last_error','2026-09-11: boom')").run();
generateReport(db, tmp);
const md3 = fs.readFileSync(tmp, 'utf8');
assert(md3.includes('本轮 CDT 采集失败'), 'CDT 失败应标注');
console.log('PASS ③ 新鲜度标注（含 CDT 未更新警示）');

fs.unlinkSync(tmp);
console.log('\nM2 自检 ALL PASS');