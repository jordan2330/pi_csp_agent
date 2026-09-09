/**
 * 会话 + 密码哈希（stdlib crypto，零依赖）
 *  - 密码: scrypt + 随机盐, 存 '<salt>:<hash>'
 *  - 会话: HMAC 签名 cookie '<uid>.<exp>.<sig>'，密钥来自 env CSP_SESSION_SECRET 或首次生成落 config/（gitignored）
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE = 'csp_sid';
const TTL_MS = 7 * 864e5;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const got = crypto.scryptSync(password || '', salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(got, 'hex'));
}

let secret = process.env.CSP_SESSION_SECRET || null;
let secretInit = false;
function getSecret() {
  if (secret) return secret;
  const file = path.join(__dirname, '..', '..', '..', 'config', '.session-secret');
  if (fs.existsSync(file)) { secret = fs.readFileSync(file, 'utf8').trim(); return secret; }
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, s, { mode: 0o600 });
  secret = s;
  return s;
}

function sign(payload) {
  return crypto.createHmac('sha256', getSecret()).update(payload).digest('hex').slice(0, 32);
}

function start(res, user) {
  const exp = Date.now() + TTL_MS;
  const payload = `${user.uid}.${exp}`;
  res.setHeader('Set-Cookie', `${COOKIE}=${payload}.${sign(payload)}; HttpOnly; Path=/; SameSite=Lax`);
}

function end(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
}

// Express 中间件: 解析 cookie → req.session（无效则 null）
function middleware(db) {
  return (req, res, next) => {
    req.session = null;
    const raw = (req.headers.cookie || '').split(';')
      .map(s => s.trim()).find(s => s.startsWith(COOKIE + '='));
    if (!raw) return next();
    const value = raw.slice(COOKIE.length + 1);
    const [uid, exp, sig] = value.split('.');
    if (!uid || !exp || !sig) return next();
    if (sign(`${uid}.${exp}`) !== sig) return next();
    if (Number(exp) < Date.now()) return next();
    const user = db.prepare('SELECT id, username, role FROM users WHERE id=?').get(Number(uid));
    if (!user) return next();
    req.session = { uid: user.id, username: user.username, role: user.role };
    next();
  };
}

module.exports = { hashPassword, verifyPassword, start, end, middleware };