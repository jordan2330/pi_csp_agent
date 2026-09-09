/**
 * 采集结果 → SQLite 写库（验收 #2 幂等、#3 原子、#6 游标同事务）
 *  - trials    按 (source, regNo) upsert；状态字段(first_seen_at/killed_*)不被覆盖
 *  - trial_apis 逐 (trial, api, drug_name) upsert
 *  - withTransaction: BEGIN/COMMIT/ROLLBACK, 供游标与数据同事务推进
 *  - 返回 { inserted, updated } 供"新增"统计与周报/导出增量使用
 */
'use strict';

const DATA_FIELDS = [
  'regDate', 'lastUpdateDate', 'sponsor', 'status', 'dosageForm',
  'trialType', 'contactName', 'contactPhone', 'contactEmail', 'piName', 'piUnit',
  'contactAddress', 'briefTitle', 'officialTitle', 'phase', 'condition', 'targetEnrollment'
];

const UPSERT_TRIAL = `INSERT INTO trials (source, regNo, ${DATA_FIELDS.map(f => `"${f}"`).join(', ')})
VALUES (${['?', '?', ...DATA_FIELDS.map(() => '?')].join(', ')})
ON CONFLICT(source, regNo) DO UPDATE SET
${DATA_FIELDS.map(f => `  "${f}" = excluded."${f}"`).join(',\n')}`;

const UPSERT_API = `INSERT INTO trial_apis (trial_source, trial_regNo, api, drug_name)
VALUES (?, ?, ?, ?)
ON CONFLICT(trial_source, trial_regNo, api) DO UPDATE SET drug_name = excluded.drug_name`;

// 预绑定语句 + 事务封装，供各 source 共用
function prepare(db) {
  return {
    insTrial: db.prepare(UPSERT_TRIAL),
    insApi: db.prepare(UPSERT_API),
    exists: db.prepare('SELECT 1 FROM trials WHERE source=? AND regNo=?')
  };
}

function withTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// rows: [{ source, regNo, api?, drugName?, ...DATA_FIELDS }]；api 为空则只写 trial
function writeTrials(db, rows) {
  const p = prepare(db);
  let inserted = 0, updated = 0;
  withTransaction(db, () => {
    for (const t of rows) {
      if (p.exists.get(t.source, t.regNo)) updated++; else inserted++;
      p.insTrial.run(t.source, t.regNo, ...DATA_FIELDS.map(f => t[f] ?? null));
      if (t.api) p.insApi.run(t.source, t.regNo, t.api, t.drugName ?? null);
    }
  });
  return { inserted, updated };
}

module.exports = { prepare, withTransaction, writeTrials, DATA_FIELDS };