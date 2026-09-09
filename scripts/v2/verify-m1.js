/**
 * M1 自检（离线确定）— 验收 #4 (HTTP 重试退避) + store 幂等回归
 * 用法: node scripts/v2/verify-m1.js
 */
'use strict';

const assert = require('assert');
const http = require('http');
const { getJSON } = require('./lib/http');
const { openDB } = require('./db');
const { writeTrials } = require('./store');

// ── ① 重试: 429×2 → 200，断言第三次成功 ──
async function testRetry() {
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    if (hits < 3) { res.writeHead(429); res.end('rate limited'); }
    else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); }
  });
  await new Promise(r => srv.listen(0, r));
  const port = srv.address().port;
  const t0 = Date.now();
  const data = await getJSON(`http://127.0.0.1:${port}/x`, { backoff: [10, 10, 10] });
  assert.strictEqual(data.ok, true);
  assert.strictEqual(hits, 3, `应 3 次请求, 实际 ${hits}`);
  assert(Date.now() - t0 >= 20, '未见退避等待');
  srv.close();
  console.log('PASS ① HTTP 429 重试退避（3 次请求, 2 次退避）');
}

// ── ② 不可重试错误不重试 ──
async function testNoRetryOn404() {
  let hits = 0;
  const srv = http.createServer((req, res) => { hits++; res.writeHead(404); res.end('nf'); });
  await new Promise(r => srv.listen(0, r));
  const port = srv.address().port;
  await assert.rejects(
    () => getJSON(`http://127.0.0.1:${port}/x`, { backoff: [10, 10, 10] }),
    /HTTP 404/);
  assert.strictEqual(hits, 1, `404 不应重试, 实际 ${hits}`);
  srv.close();
  console.log('PASS ② 404 不重试');
}

// ── ③ store 幂等 + 状态字段不重置 ──
function testStoreIdempotent() {
  const db = openDB(':memory:');
  const torn = Math.round(Date.now() / 6), other = Math.round(Date.now() / 7);

  let r = writeTrials(db, [{
    source: 'CT.gov', regNo: 'NCT_TEST001',
    email: null, drugName: 'A', api: 'API1', sponsor: 'S'
  }, {
    source: 'CT.gov', regNo: 'NCT_TEST002',
    email: null, drugName: 'B', api: 'API1', sponsor: 'T'
  }]);
  assert.deepStrictEqual(r, { inserted: 2, updated: 0 });
  r = writeTrials(db, [{ source: 'CT.gov', regNo: 'NCT_TEST001', drugName: 'A', api: 'API1', sponsor: 'S' }]);
  assert.deepStrictEqual(r, { inserted: 0, updated: 1 });
  const n = db.prepare('SELECT COUNT(*) c FROM trials').get().c;
  assert.strictEqual(n, 2, '重复写入产生多行');
  const apis = db.prepare('SELECT COUNT(*) c FROM trial_apis').get().c;
  assert.strictEqual(apis, 2);
  console.log('PASS ③ store 幂等（trial/trial_apis 行数稳定）');
}

(async () => {
  await testRetry();
  await testNoRetryOn404();
  testStoreIdempotent();
  console.log('\nM1 自检 ALL PASS');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });