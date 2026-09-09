/**
 * v2 持久化层 — schema + 连接
 *
 * 决策来源: docs/v2-requirements.md
 *  - trials:      (source, regNo) 唯一, trial 级采集字段, first_seen_at 只 INSERT 不 UPDATE
 *  - trial_apis:  M2M (trial 命中多个 API); drug_name 是 per-API 值, 存这里
 *  - fda_apis:    FDA 专用表 (中英文字段)
 *  - exported_emails: 导出增量 email 级
 *  - meta:        key-value (CDT 游标等)
 *  - users:       web 登录
 */
'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trials (
  source         TEXT NOT NULL,
  regNo          TEXT NOT NULL,
  regDate        TEXT,
  lastUpdateDate TEXT,
  sponsor        TEXT,
  status         TEXT,
  dosageForm     TEXT,
  trialType      TEXT,
  contactName    TEXT,
  contactPhone   TEXT,
  contactEmail   TEXT,
  piName         TEXT,
  piUnit         TEXT,
  contactAddress TEXT,
  briefTitle     TEXT,
  officialTitle  TEXT,
  phase          TEXT,
  condition      TEXT,
  targetEnrollment TEXT,
  first_seen_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  killed_at      TEXT,
  kill_reason    TEXT,
  PRIMARY KEY (source, regNo)
);

CREATE TABLE IF NOT EXISTS trial_apis (
  trial_source TEXT NOT NULL,
  trial_regNo  TEXT NOT NULL,
  api          TEXT NOT NULL,
  drug_name    TEXT,
  PRIMARY KEY (trial_source, trial_regNo, api)
);

CREATE TABLE IF NOT EXISTS fda_apis (
  en_name   TEXT PRIMARY KEY,
  cn_name   TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS exported_emails (
  email       TEXT PRIMARY KEY,
  exported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'bd',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

function openDB(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDB, SCHEMA };