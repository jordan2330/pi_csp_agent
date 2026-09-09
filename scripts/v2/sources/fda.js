/**
 * FDA 数据源（亚硝胺场景）— 缓存 JSON → fda_apis 表
 *  - 中英文字段: en_name(JSON key) + cn_name(name_cn)
 *  - fda_page_version → meta
 *  - 缓存缺失/损坏 = 报错退出（验收 #1 禁止静默默认）
 */
'use strict';

const fs = require('fs');
const { prepare, withTransaction } = require('../store');

function ingestFDA(db, cacheFile, { log = () => {} } = {}) {
  if (!fs.existsSync(cacheFile)) {
    throw new Error(`FDA 缓存不存在: ${cacheFile}（先跑 FDA 页抓取 Phase 1）`);
  }
  const fda = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  const apis = fda.apis || {};
  const version = fda.fda_page_version || 'unknown';
  const keys = Object.keys(apis);
  if (keys.length === 0) throw new Error(`FDA 缓存为空: ${cacheFile}`);

  const p = prepare(db);
  const upsert = db.prepare(`INSERT INTO fda_apis (en_name, cn_name, updated_at) VALUES (?, ?, ?)
ON CONFLICT(en_name) DO UPDATE SET cn_name = excluded.cn_name, updated_at = excluded.updated_at`);

  withTransaction(db, () => {
    for (const en of keys) {
      upsert.run(en, apis[en].name_cn || null, version);
    }
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('fda_page_version', version);
  });

  log(`FDA 入表: ${keys.length} 个 API, 版本 ${version}`);
  return { count: keys.length, version };
}

module.exports = { ingestFDA };