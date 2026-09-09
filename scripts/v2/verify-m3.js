/**
 * M3 web 自检（离线确定，supertest 零依赖 —— 用 http 直连临时端口）
 *  ① 未登录 302→登录页  ② 登录成功进首页(聚合统计)
 *  ③ 编辑 email 后进入导出候选  ④ 毙掉/恢复状态持久  ⑤ 缺邮箱清单
 * 用法: node scripts/v2/verify-m3.js
 */
'use strict';

const assert = require('assert');
const http = require('http');
const { openDB } = require('./db');
const { hashPassword } = require('./lib/session');
const { createApp, exportCandidates } = require('./web');

const db = openDB(':memory:');
db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
  .run('bd1', hashPassword('pw123'), 'bd');
db.prepare('INSERT INTO fda_apis (en_name, cn_name) VALUES (?, ?)').run('Acarbose', '阿卡波糖');
const ins = db.prepare(`INSERT INTO trials
  (source, regNo, sponsor, contactEmail, contactName, contactPhone, first_seen_at, killed_at, kill_reason)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const insApi = db.prepare(`INSERT INTO trial_apis (trial_source, trial_regNo, api, drug_name) VALUES (?, ?, ?, ?)`);
ins.run('CT.gov', 'NCT_W1', '公司甲', 'a@x.com', '张三', '13800000000', '2026-09-01T00:00:00Z', null, null);
insApi.run('CT.gov', 'NCT_W1', 'Acarbose', '阿卡波糖片');
ins.run('CDT', 'CTR_W2', '公司乙', 'a@x.com', '李四', '13900000000', '2026-09-02T00:00:00Z', null, null);
insApi.run('CDT', 'CTR_W2', 'Acarbose', '阿卡波糖胶囊');
ins.run('CT.gov', 'NCT_W3', '公司丙', null, '王五', null, '2026-09-03T00:00:00Z', null, null);
insApi.run('CT.gov', 'NCT_W3', 'Acarbose', '阿卡波糖');

const app = createApp(db);
const srv = http.createServer(app);

function req(path, { method = 'GET', form, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const body = form ? new URLSearchParams(form).toString() : null;
    const reqOpt = { method, path, headers: {} };
    if (cookie) reqOpt.headers.Cookie = cookie;
    if (body) { reqOpt.headers['Content-Type'] = 'application/x-www-form-urlencoded'; reqOpt.headers['Content-Length'] = Buffer.byteLength(body); }
    const r = http.request({ host: '127.0.0.1', port: srv.address().port, ...reqOpt }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
const cookieOf = res => (res.headers['set-cookie'] || [''])[0].split(';')[0];

(async () => {
  await new Promise(r => srv.listen(0, r));

  // ① 未登录重定向
  const r1 = await req('/');
  assert.strictEqual(r1.status, 302, `未登录应 302, 实际 ${r1.status}`);

  // ② 错误密码
  const bad = await req('/login', { method: 'POST', form: { username: 'bd1', password: 'wrong' } });
  assert.match(bad.headers.location || '', /login\?e=1/);

  // 正确登录
  const ok = await req('/login', { method: 'POST', form: { username: 'bd1', password: 'pw123' } });
  const cookie = cookieOf(ok);
  assert(cookie, '登录应下发 cookie');

  const home = await req('/', { cookie });
  assert.strictEqual(home.status, 200);
  assert.match(home.body.toString(), /CSP 审核台/);
  assert.match(home.body.toString(), /a@x\.com/);

  // ③ 编辑补全 email
  await req('/trials/CT.gov/NCT_W3/edit', {
    method: 'POST', cookie,
    form: { contactEmail: 'new@y.com', contactName: '王五', contactPhone: '' }
  });
  // exportCandidates 应从 1 个 email 变 2 个
  const cands = exportCandidates(db);
  const emails = new Set(cands.map(c => c.email));
  assert(emails.has('a@x.com') && emails.has('new@y.com'), `候选应含 new@y.com: ${[...emails]}`);
  const maybe = cands.find(c => c.email === 'new@y.com');
  assert.strictEqual(maybe.trialCount, 1);

  // ④ 毙掉/恢复
  await req('/trials/CT.gov/NCT_W1/kill', { method: 'POST', cookie, form: { reason: '测试毙掉' } });
  let row = db.prepare('SELECT killed_at, kill_reason FROM trials WHERE regNo=?').get('NCT_W1');
  assert(row.killed_at && row.kill_reason === '测试毙掉');
  await req('/trials/CT.gov/NCT_W1/restore', { method: 'POST', cookie });
  row = db.prepare('SELECT killed_at FROM trials WHERE regNo=?').get('NCT_W1');
  assert.strictEqual(row.killed_at, null);

  // ⑤ 缺邮箱清单（NCT_W3 已补 → 0 条）
  const noEmail = await req('/no-email', { cookie });
  assert.strictEqual(noEmail.status, 200);
  assert(!noEmail.body.toString().includes("NCT_W3"));

  // ⑥ 验证 session 有效性（伪造 cookie 拒绝）
  const fake = await req('/', { cookie: 'csp_sid=1.9999999999.deadbeef' });
  assert.strictEqual(fake.status, 302);

  // ⑦ 导出端点: 预览含候选人 → POST 下载 xlsx → 导出后再看候选为空
  const expPage = await req('/export', { cookie });
  assert.strictEqual(expPage.status, 200);
  assert(expPage.body.toString().includes('a@x.com'), '导出预览应含候选人');
  const dl = await req('/export', { method: 'POST', cookie, form: { email: 'a@x.com' } });
  assert.strictEqual(dl.status, 200, 'xlsx 下载应 200');
  assert.match(dl.headers['content-type'] || '', /spreadsheetml/);
  assert(dl.body[0] === 0x50 && dl.body[1] === 0x4b, 'xlsx 魔数 (PK)');
  const home2 = await req('/', { cookie });
  assert(!home2.body.toString().includes('a@x.com'), '已导出 email 不应再是候选');

  console.log('PASS ① 认证 ② 登录 ③ 编辑补全→候选 ④ 毙掉/恢复 ⑤ 缺邮箱清单 ⑥ 伪造会话拒绝 ⑦ 导出端点');
  console.log('\nM3 自检 ALL PASS');
  srv.close();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });