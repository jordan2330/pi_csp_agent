/**
 * fixture → SQLite 摄入（Milestone 0）
 *
 * 幂等规则（docs/v2-requirements.md 附录 C/B）：
 *  - trials 按 (source, regNo) upsert：数据字段可更新，first_seen_at / killed_at 不重置
 *  - trial_apis INSERT OR IGNORE
 *  - 整体单事务（进程被杀 = 全不落库）
 *
 * 用法: node scripts/v2/ingest-fixture.js [dbPath] [fixturePath]
 */
'use strict';

const { openDB } = require('./db');

const dbPath = process.argv[2] || 'config/csp.db';
const fixturePath = process.argv[3] || 'docs/fixtures/ctgov-golden-2026-08-28.json';

const DATA_FIELDS = [
  'regDate', 'lastUpdateDate', 'sponsor', 'status', 'dosageForm',
  'trialType', 'contactName', 'contactPhone', 'contactEmail', 'piName', 'piUnit',
  'contactAddress', 'briefTitle', 'officialTitle', 'phase', 'condition', 'targetEnrollment'
];
// upsert: 数据字段更新, first_seen_at/killed_at/kill_reason 原样保留
const UPSERT = `INSERT INTO trials (source, regNo, ${DATA_FIELDS.join(', ')})
VALUES (${['?', '?', ...DATA_FIELDS.map(() => '?')].join(', ')})
ON CONFLICT(source, regNo) DO UPDATE SET
${DATA_FIELDS.map(f => `  ${f} = excluded.${f}`).join(',\n')}`;

function ingestFixture(db, fixture) {
  db.exec('BEGIN');
  try {
    const insTrial = db.prepare(UPSERT);
    const insApi = db.prepare('INSERT OR IGNORE INTO trial_apis (trial_source, trial_regNo, api, drug_name) VALUES (?, ?, ?, ?)');
    console.log('records:', fixture.records.length);
    for (const t of fixture.records) {
      insTrial.run(t.source, t.regNo, ...DATA_FIELDS.map(f => t[f] ?? null));
      insApi.run(t.source, t.regNo, t.api, t.drugName ?? null);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return {
    trials: db.prepare('SELECT COUNT(*) c FROM trials').get().c,
    trial_apis: db.prepare('SELECT COUNT(*) c FROM trial_apis').get().c
  };
}

if (require.main === module) {
  const db = openDB(dbPath);
  const fixture = JSON.parse(require('fs').readFileSync(fixturePath, 'utf8'));
  console.log('ingest <-', fixturePath, '->', dbPath);
  console.log('done:', ingestFixture(db, fixture));
}

module.exports = { ingestFixture, DATA_FIELDS };  // DATA_FIELDS 供对拍脚本复用