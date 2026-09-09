/**
 * Milestone 0 对拍验收 — 附录 C 四条（全离线、确定性）
 *  ① 字段保真往返  ② upsert 幂等  ③ 导出增量/毙掉状态持久  ④ 游标持久化(+事务原子)
 *
 * 用法: node scripts/v2/verify-m0.js [dbPath]
 *  PASS 全部通过 exit 0；任何断言失败 exit 1。
 */
'use strict';

const assert = require('assert');
const { openDB } = require('./db');
const { ingestFixture, DATA_FIELDS } = require('./ingest-fixture');

const dbPath = process.argv[2] || 'config/csp.db';
const fixturePath = process.argv[3] || 'docs/fixtures/ctgov-golden-2026-08-28.json';
const fixture = JSON.parse(require('fs').readFileSync(fixturePath, 'utf8'));
const META = fixture.meta;

const db = openDB(dbPath);

// trial 级字段（drug_name 属 per-API, 不在 trials 上）
const RECORD_FIELDS = [...DATA_FIELDS].sort();

// 单 API 试验: trial 级字段无歧义, 用于严格往返验证
const singleApi = fixture.records.filter(r =>
  fixture.records.filter(x => x.source === r.source && x.regNo === r.regNo).length === 1);
const multiApi = fixture.records.filter(r =>
  fixture.records.filter(x => x.source === r.source && x.regNo === r.regNo).length > 1);

// ── ① 字段保真往返 + ④ 游标事务 ──
function testRoundTrip() {
  db.prepare('DELETE FROM trials').run();
  db.prepare('DELETE FROM trial_apis').run();
  db.prepare('DELETE FROM meta').run();
  db.prepare('DELETE FROM exported_emails').run();
  ingestFixture(db, fixture);

  const rows = db.prepare('SELECT COUNT(*) c FROM trials').get().c;
  assert.strictEqual(rows, META.ctgov_unique_trials,
    `trials 去重后应 ${META.ctgov_unique_trials}, 实际 ${rows}`);
  const apis = db.prepare('SELECT COUNT(*) c FROM trial_apis').get().c;
  assert.strictEqual(apis, META.ctgov_records,
    `trial_apis 应 ${META.ctgov_records} 行, 实际 ${apis}`);

  // 逐字段: 从 DB 抽 50 条对照 fixture 原始值
  const pick = singleApi.filter((_, i) => i % Math.ceil(singleApi.length / 50) === 0).slice(0, 50);
  for (const t of pick) {
    const row = db.prepare('SELECT * FROM trials WHERE source=? AND regNo=?').get(t.source, t.regNo);
    assert(row, `失踪: ${t.source}|${t.regNo}`);
    for (const f of RECORD_FIELDS) {
      const want = t[f] ?? null;
      assert.strictEqual(row[f], want, `字段不一致 ${t.regNo}.${f}: ${row[f]} != ${want}`);
    }
    const api = db.prepare('SELECT api FROM trial_apis WHERE trial_source=? AND trial_regNo=?').get(t.source, t.regNo);
    assert(api, `trial_apis 缺 ${t.regNo}`);
  }
  // 多 API 试验: per-API drug_name 完整且对上 API
  let checked = 0;
  for (const key of [...new Set(multiApi.map(r => r.source + '|' + r.regNo))].slice(0, 50)) {
    const [src, reg] = key.split('|');
    const want = multiApi.filter(r => r.source === src && r.regNo === reg)
      .map(r => [r.api, r.drugName ?? null]);
    const rows = db.prepare('SELECT api, drug_name FROM trial_apis WHERE trial_source=? AND trial_regNo=? ORDER BY api').all(src, reg);
    assert.strictEqual(rows.length, want.length, `${reg} API 数不符`);
    for (const [api, dn] of want) {
      const row = rows.find(r => r.api === api);
      assert(row, `${reg} 缺 API ${api}`);
      assert.strictEqual(row.drug_name, dn, `${reg}.${api} drug_name 不符`);
    }
    checked++;
  }
  assert(checked > 0, '无多 API 样本');
  console.log(`PASS ① 字段保真往返（${pick.length} 单API + ${checked} 多API）`);
}

// ── ② upsert 幂等 ──
function testIdempotent() {
  const t = fixture.records[0];
  db.prepare("UPDATE trials SET first_seen_at='2026-01-01T00:00:00Z' WHERE source=? AND regNo=?")
    .run(t.source, t.regNo);
  ingestFixture(db, fixture);   // 第三遍
  const row = db.prepare('SELECT first_seen_at FROM trials WHERE source=? AND regNo=?').get(t.source, t.regNo);
  assert.strictEqual(row.first_seen_at, '2026-01-01T00:00:00Z', 'first_seen_at 被重置');
  const n = db.prepare('SELECT COUNT(*) c FROM trials').get().c;
  assert.strictEqual(n, META.ctgov_unique_trials, '重灌产生重复或丢行');
  console.log('PASS ② upsert 幂等（first_seen_at 不被重置）');
}

// ── ③ 导出增量/毙掉状态持久 ──
function testStatePersistence() {
  const t = fixture.records[10];
  const email = t.contactEmail;
  db.prepare('UPDATE trials SET killed_at=?, kill_reason=? WHERE source=? AND regNo=?')
    .run('2026-09-03T10:00:00Z', '测试毙掉', t.source, t.regNo);
  if (email) db.prepare('INSERT OR IGNORE INTO exported_emails (email, exported_at) VALUES (?, ?)')
    .run(email, '2026-09-03T09:00:00Z');
  ingestFixture(db, fixture);   // 重灌
  const row = db.prepare('SELECT killed_at, kill_reason FROM trials WHERE source=? AND regNo=?').get(t.source, t.regNo);
  assert.strictEqual(row.killed_at, '2026-09-03T10:00:00Z', 'killed_at 被重置');
  assert.strictEqual(row.kill_reason, '测试毙掉', 'kill_reason 被重置');
  if (email) {
    const e = db.prepare('SELECT exported_at FROM exported_emails WHERE email=?').get(email);
    assert(e, 'exported_emails 丢失');
  }
  console.log('PASS ③ 毙掉/导出状态重灌后持久');
}

// ── ④ 游标持久化 + 事务原子 ──
function testMetaAndTxn() {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('last_cdt_regno', 'CTR20249999');
  assert.strictEqual(
    db.prepare('SELECT value FROM meta WHERE key=?').get('last_cdt_regno').value,
    'CTR20249999', 'meta 读回不一致');
  // 原子性: 回滚后 meta 与行同生共死
  db.exec('BEGIN');
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('last_cdt_regno', 'CTR20248888');
  db.prepare("INSERT INTO trials (source, regNo) VALUES ('CDT','CTR_ROLLBACK_TEST')").run();
  db.exec('ROLLBACK');
  assert.strictEqual(
    db.prepare('SELECT value FROM meta WHERE key=?').get('last_cdt_regno').value,
    'CTR20249999', 'ROLLBACK 后 meta 未还原');
  assert(!db.prepare("SELECT 1 FROM trials WHERE regNo='CTR_ROLLBACK_TEST'").get(), 'ROLLBACK 后行残留');
  console.log('PASS ④ 游标持久化 + 事务原子');
}

testRoundTrip();
testIdempotent();
testStatePersistence();
testMetaAndTxn();
console.log(`\nALL PASS — fixture: ${META.ctgov_records} 记录 / ${META.ctgov_unique_trials} 唯一试验`);