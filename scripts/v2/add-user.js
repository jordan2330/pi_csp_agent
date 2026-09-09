#!/usr/bin/env node
/**
 * 创建登录用户
 * 用法: node scripts/v2/add-user.js <username> <password> [role]   # role 默认 bd
 *       密码也可从 CSP_ADMIN_PASSWORD env 读: node scripts/v2/add-user.js admin
 */
'use strict';

const path = require('path');
const { openDB } = require('./db');
const { hashPassword } = require('./lib/session');

const ROOT = path.join(__dirname, '..', '..');
const username = process.argv[2];
const password = process.argv[3] || process.env.CSP_ADMIN_PASSWORD;
const role = process.argv[4] || 'bd';

if (!username || !password) {
  console.error('用法: node scripts/v2/add-user.js <username> <password> [role]');
  process.exit(1);
}

const db = openDB(process.env.CSP_DB || path.join(ROOT, 'config', 'csp.db'));
db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash, role=excluded.role')
  .run(username, hashPassword(password), role);
console.log(`用户就绪: ${username} (${role})`);