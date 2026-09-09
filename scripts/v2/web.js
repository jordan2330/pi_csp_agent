/**
 * web 审核台 — Express + SSR + node:sqlite（M3）
 *
 * 锁定决策（docs/v2-requirements.md 附录 E/F）:
 *  - 登录: users 表 + 会话；wrap 简单权限（bd/admin）
 *  - 审核: 按 email 聚合的导出候选行 + 反选（默认全选）
 *  - 编辑: trial 的 email/电话/姓名可补全修改（存 DB 复用）
 *  - 毙掉/恢复: trial 级 killed_at（SF 兜底，不建第二套状态）
 *
 * 技术: Express + 服务端渲染 + node:sqlite（stdilib, 零 native 依赖）
 *   — 附录 F 原写 better-sqlite3，M0 起改用 node:sqlite，API 同构
 */
'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('./lib/session');
const { openDB } = require('./db');
const { esc } = require('./report');

const ROOT = path.join(__dirname, '..', '..');
const DB_PATH = process.env.CSP_DB || path.join(ROOT, 'config', 'csp.db');
const PORT = Number(process.env.PORT || 3000);

function createApp(db) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(session.middleware(db));

  // ── 登录页 ──
  app.get('/login', (req, res) => {
    if (req.session) return res.redirect('/');
    res.send(page('登录', `
      <form method="POST" action="/login" class="card w360">
        <h2>CSP 审核台</h2>
        <label>用户名 <input name="username" autofocus></label>
        <label>密码 <input name="password" type="password"></label>
        <button type="submit">登录</button>
        ${req.query.e ? '<p class="err">用户名或密码错误</p>' : ''}
      </form>`));
  });

  app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE username=?').get(username || '');
    if (user && session.verifyPassword(password || '', user.password_hash)) {
      session.start(res, { uid: user.id, username: user.username, role: user.role });
      return res.redirect('/');
    }
    res.redirect('/login?e=1');
  });

  app.get('/logout', (req, res) => { session.end(res); res.redirect('/login'); });

  // ── 审核台主页 ──
  app.get('/', (req, res) => {
    if (!req.session) return res.redirect('/login');

    const freshness = {
      ctgov: db.prepare("SELECT value FROM meta WHERE key='ctgov_as_of'").get()?.value || 'NEVER',
      cdt: db.prepare("SELECT value FROM meta WHERE key='cdt_as_of'").get()?.value || 'NEVER',
      cdtErr: db.prepare("SELECT value FROM meta WHERE key='cdt_last_error'").get()?.value || null
    };
    const stats = {
      trials: db.prepare('SELECT COUNT(*) c FROM trials').get().c,
      killed: db.prepare('SELECT COUNT(*) c FROM trials WHERE killed_at IS NOT NULL').get().c,
      noEmail: db.prepare('SELECT COUNT(*) c FROM trials WHERE contactEmail IS NULL OR contactEmail=\'\'').get().c
    };

    const rows = exportCandidates(db);
    const emailSet = new Set();
    const candidates = rows.filter(r => { if (emailSet.has(r.email)) return false; emailSet.add(r.email); return true; });

    const body = `
      <h1>CSP 审核台</h1>
      <p class="muted">${esc(req.session.username)} (${esc(req.session.role)}) · <a href="/logout">退出</a></p>

      <div class="stats">
        <div class="stat"><b>${stats.trials}</b><span>试验总数</span></div>
        <div class="stat"><b>${candidates.length}</b><span>待导出 lead</span></div>
        <div class="stat"><b>${stats.killed}</b><span>已毙掉</span></div>
        <div class="stat"><b>${stats.noEmail}</b><span>缺邮箱</span></div>
      </div>

      <p><a class="btn" href="/export">📥 导出 Salesforce Excel</a></p>

      <div class="fresh card">
        <b>数据新鲜度</b>
        <span>CT.gov 截至 ${esc(freshness.ctgov)}</span>
        <span>CDT 截至 ${esc(freshness.cdt)}${freshness.cdtErr ? ' <b class="err">⚠️ 本轮采集失败（未更新）</b>' : ''}</span>
      </div>

      <h2>导出候选（${candidates.length}）<span class="muted">默认全选，取消勾选 = 本批不导；⚰️ = 该 email 全部试验被毙</span></h2>
      <table>
        <tr><th>导</th><th>Email</th><th>公司</th><th>试验数</th><th>活/毙</th><th>最早收录</th><th>操作</th></tr>
        ${candidates.map(r => `
          <tr>
            <td><input type="checkbox" checked disabled></td>
            <td>${esc(r.email)}</td>
            <td>${esc(r.company)}</td>
            <td>${r.trialCount}</td>
            <td>${r.live}/${r.killed}</td>
            <td>${esc((r.firstSeen || '').slice(0, 10))}</td>
            <td><a href="/trials?email=${encodeURIComponent(r.email)}">查看</a></td>
          </tr>`).join('')}
      </table>
      <p><a href="/no-email">缺邮箱清单（${stats.noEmail}）→</a></p>`;

    res.send(page('CSP 审核台', body));
  });

  // ── 导出（M4）: 预览 + 反选勾选 → xlsx 下载 + 标记 exported_emails ──
  app.get('/export', (req, res) => {
    if (!req.session) return res.redirect('/login');
    const rows = exportCandidates(db);
    const body = `
      <p><a href="/">← 返回</a></p>
      <h2>导出为 Salesforce Excel</h2>
      <p class="muted">每个唯一 email 一行（SF 按 email 判重）。勾选 = 本批导出（已毙 trial 不参与聚合）。</p>
      <form method="POST" action="/export">
        <table>
          <tr><th>导</th><th>Email</th><th>公司</th><th>活试验数</th><th>联系人</th></tr>
          ${rows.map(r => `
            <tr>
              <td><input type="checkbox" name="email" value="${esc(r.email)}" checked></td>
              <td>${esc(r.email)}</td>
              <td>${esc(r.company)}</td>
              <td>${r.live}</td>
              <td>${r.trialCount}</td>
            </tr>`).join('')}
        </table>
        ${rows.length ? '<button type="submit">生成并下载 Excel（标记已导出）</button>' : '<p>没有任何可导出的 lead（缺 email 的先去补全）。</p>'}
      </form>`;
    res.send(page('导出 Excel', body));
  });

  app.post('/export', async (req, res) => {
    if (!req.session) return res.redirect('/login');
    const emails = Array.isArray(req.body.email) ? req.body.email : (req.body.email ? [req.body.email] : []);
    if (emails.length === 0) return res.redirect('/export');
    const { buildExcel, markExported } = require('./export');
    const { buffer } = buildExcel(db, { emails });
    markExported(db, emails);
    const buf = await buffer();
    const fname = `CSP_leads_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(Buffer.from(buf));
  });

  // ── 按 email 查看该 lead 下全部 trial（展开编辑） ──
  app.get('/trials', (req, res) => {
    if (!req.session) return res.redirect('/login');
    const email = req.query.email || '';
    const trials = db.prepare(`SELECT * FROM trials
      WHERE contactEmail=? ORDER BY regDate DESC`).all(email);

    const body = `
      <p><a href="/">← 返回</a></p>
      <h2>${esc(email)} 下的试验（${trials.length}）</h2>
      ${trials.map(t => `
        <div class="card ${t.killed_at ? 'killed' : ''}">
          <div class="trial-head">
            <b>${esc(t.regNo)}</b> · ${esc(t.source)}
            ${t.killed_at ? `<span class="err">⚰️ 已毙 (${esc(t.killed_at.slice(0, 10))}) — ${esc(t.kill_reason || '')}</span>` : ''}
          </div>
          <p>${esc(t.briefTitle || t.officialTitle || '')}</p>
          <p class="muted">${esc(t.sponsor || '')} | ${esc(t.drugName || '')} …</p>
          <form method="POST" action="/trials/${encodeURIComponent(t.source)}/${encodeURIComponent(t.regNo)}/edit">
            <label>Email <input name="contactEmail" value="${esc(t.contactEmail || '')}"></label>
            <label>姓名 <input name="contactName" value="${esc(t.contactName || '')}"></label>
            <label>电话 <input name="contactPhone" value="${esc(t.contactPhone || '')}"></label>
            <button type="submit">保存</button>
          </form>
          ${t.killed_at
            ? `<form method="POST" action="/trials/${encodeURIComponent(t.source)}/${encodeURIComponent(t.regNo)}/restore"><button type="submit">恢复</button></form>`
            : `<form method="POST" action="/trials/${encodeURIComponent(t.source)}/${encodeURIComponent(t.regNo)}/kill">
                 <input name="reason" placeholder="毙掉原因" required>
                 <button type="submit" class="danger">毙掉</button>
               </form>`}
        </div>`).join('')}`;

    res.send(page('lead 详情', body));
  });

  app.post('/trials/:source/:regNo/edit', (req, res) => {
    if (!req.session) return res.redirect('/login');
    const { source, regNo } = req.params;
    const keys = ['contactEmail', 'contactName', 'contactPhone'];
    const sets = keys.map(k => `${k}=?`).join(', ');
    db.prepare(`UPDATE trials SET ${sets} WHERE source=? AND regNo=?`)
      .run(...keys.map(k => req.body[k] ?? null), source, regNo);
    res.redirect(`/trials?email=${encodeURIComponent(req.body.contactEmail || '')}`);
  });

  app.post('/trials/:source/:regNo/kill', (req, res) => {
    if (!req.session) return res.redirect('/login');
    db.prepare('UPDATE trials SET killed_at=?, kill_reason=? WHERE source=? AND regNo=?')
      .run(new Date().toISOString(), req.body.reason || '', req.params.source, req.params.regNo);
    res.redirect(req.get('Referrer') || '/');
  });

  app.post('/trials/:source/:regNo/restore', (req, res) => {
    if (!req.session) return res.redirect('/login');
    db.prepare('UPDATE trials SET killed_at=NULL, kill_reason=NULL WHERE source=? AND regNo=?')
      .run(req.params.source, req.params.regNo);
    res.redirect(req.get('Referrer') || '/');
  });

  // ── 缺 email 清单 ──
  app.get('/no-email', (req, res) => {
    if (!req.session) return res.redirect('/login');
    const rows = db.prepare(`SELECT * FROM trials
      WHERE contactEmail IS NULL OR contactEmail='' ORDER BY regDate DESC LIMIT 200`).all();
    const body = `
      <p><a href="/">← 返回</a></p>
      <h2>缺邮箱试验（${rows.length} 条，补全后自动进入导出候选）</h2>
      ${rows.map(t => `
        <div class="card">
          <b>${esc(t.regNo)}</b> <span class="muted">${esc(t.source)}</span>
          <p>${esc(t.sponsor || '')} — ${esc(t.briefTitle || '')}</p>
          <form method="POST" action="/trials/${encodeURIComponent(t.source)}/${encodeURIComponent(t.regNo)}/edit">
            <label>Email <input name="contactEmail" placeholder="补全 email"></label>
            <label>姓名 <input name="contactName" value="${esc(t.contactName || '')}"></label>
            <button type="submit">保存</button>
          </form>
        </div>`).join('')}`;
    res.send(page('缺邮箱清单', body));
  });

  return app;
}

// 导出候选: 按非空 email 聚合（每 email 一行），被毙试验不下沉行但计入 killed 数
function exportCandidates(db) {
  return db.prepare(`
    SELECT contactEmail AS email,
           (SELECT sponsor FROM trials t2 WHERE t2.contactEmail = t.contactEmail
              AND t2.killed_at IS NULL
              ORDER BY regDate DESC LIMIT 1) AS company,
           COUNT(*) AS trialCount,
           SUM(CASE WHEN killed_at IS NOT NULL THEN 1 ELSE 0 END) AS killed,
           SUM(CASE WHEN killed_at IS NULL THEN 1 ELSE 0 END) AS live,
           MIN(first_seen_at) AS firstSeen
    FROM trials t
    WHERE contactEmail IS NOT NULL AND contactEmail != ''
      AND contactEmail NOT IN (SELECT email FROM exported_emails)
    GROUP BY contactEmail
    HAVING SUM(CASE WHEN killed_at IS NULL THEN 1 ELSE 0 END) > 0
    ORDER BY firstSeen DESC`).all();
}

function page(title, body) {
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;max-width:880px;margin:24px auto;padding:0 16px;color:#222}
  h1{font-size:1.5em} h2{font-size:1.2em;margin-top:1.6em}
  a{color:#0b5cad}
  a.btn{display:inline-block;background:#0b5cad;color:#fff;text-decoration:none;border-radius:4px;padding:8px 14px;margin:6px 0}
  .card{border:1px solid #ddd;border-radius:8px;padding:12px 16px;margin:10px 0;background:#fff}
  .card.killed{background:#fff5f5;border-color:#f0c0c0}
  .w360{max-width:360px;margin:60px auto}
  label{display:block;margin:8px 0;font-size:.9em}
  input{border:1px solid #ccc;border-radius:4px;padding:6px 8px}
  form.inline{display:inline}
  button{background:#0b5cad;color:#fff;border:0;border-radius:4px;padding:7px 14px;margin:4px 0;cursor:pointer}
  button.danger{background:#b00020}
  .stats{display:flex;gap:12px;flex-wrap:wrap;margin:14px 0}
  .stat{flex:1;min-width:130px;border:1px solid #ddd;border-radius:8px;padding:10px;text-align:center;background:#fafafa}
  .stat b{display:block;font-size:1.6em}
  .stat span{font-size:.8em;color:#666}
  .fresh span{display:inline-block;margin-right:16px}
  .err{color:#b00020} .muted{color:#666;font-size:.85em}
  table{border-collapse:collapse;width:100%;font-size:.9em}
  th,td{border-bottom:1px solid #eee;padding:6px 8px;text-align:left;vertical-align:top}
  th{background:#f4f4f4}
  .trial-head{margin-bottom:6px}
  @media (max-width:600px){label{display:block}input{width:100%;box-sizing:border-box}button{margin-top:6px}}
</style></head><body>${body}</body></html>`;
}

module.exports = { createApp, exportCandidates };

if (require.main === module) {
  const users = dbChecks();
  const db = openDB(DB_PATH);
  const app = createApp(db);
  app.listen(PORT, () => {
    console.log(`审核台: http://localhost:${PORT}  (DB: ${DB_PATH})`);
    if (users === 0) {
      console.log('⚠️ users 表为空 —— 用 scripts/v2/add-user.js 创建登录账号');
    }
  });
}

function dbChecks() {
  const db = openDB(DB_PATH);
  return db.prepare('SELECT COUNT(*) c FROM users').get().c;
}