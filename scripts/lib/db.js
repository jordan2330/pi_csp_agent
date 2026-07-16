/**
 * PostgreSQL 数据访问层（场景无关）
 *
 * 职责：
 *   - 数据库连接管理
 *   - Schema 初始化（CREATE TABLE IF NOT EXISTS）
 *   - 默认数据填充（lead_statuses）
 *   - CRUD 函数供 run-pipeline.js / report.js / web app 调用
 *
 * 环境变量：
 *   DATABASE_URL=postgresql://user:pass@host:5432/dbname
 */

const { Client } = require('pg');

let client = null;

// ══════════════════════════════════════════════════
// 初始化
// ══════════════════════════════════════════════════

async function init() {
  const connStr = process.env.DATABASE_URL;
  if (!connStr) throw new Error('DATABASE_URL not set');
  client = new Client({ connectionString: connStr });
  await client.connect();
  await initSchema();
  await seedDefaults();
  return client;
}

async function close() {
  if (client) await client.end();
}

async function initSchema() {
  await client.query(`
    CREATE TABLE IF NOT EXISTS apis (
      scenario       TEXT NOT NULL DEFAULT 'nitrosamine',
      name_en        TEXT NOT NULL,
      name_cn        TEXT,
      metadata       JSONB DEFAULT '{}',
      source_version TEXT,
      detected_at    TEXT,
      created_at     TIMESTAMP DEFAULT NOW(),
      updated_at     TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (scenario, name_en)
    );

    CREATE TABLE IF NOT EXISTS search_state (
      scenario         TEXT NOT NULL DEFAULT 'nitrosamine',
      api_name         TEXT NOT NULL,
      source           TEXT NOT NULL,
      last_cursor      TEXT DEFAULT '',
      last_searched_at TEXT,
      lead_count       INTEGER DEFAULT 0,
      PRIMARY KEY (scenario, api_name, source)
    );

    CREATE TABLE IF NOT EXISTS trials (
      scenario            TEXT NOT NULL DEFAULT 'nitrosamine',
      api_name            TEXT NOT NULL,
      source              TEXT NOT NULL,
      reg_no              TEXT NOT NULL,
      reg_date            TEXT,
      sponsor             TEXT,
      status              TEXT,
      drug_name           TEXT,
      dosage_form         TEXT,
      drug_classification TEXT,
      trial_type          TEXT,
      contact_name        TEXT,
      contact_phone       TEXT,
      contact_email       TEXT,
      contact_address    TEXT,
      pi_name            TEXT,
      pi_unit            TEXT,
      brief_title        TEXT,
      official_title     TEXT,
      target_enrollment  TEXT,
      last_update_date   TEXT,
      is_new             BOOLEAN DEFAULT false,
      created_at         TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (scenario, api_name, source, reg_no)
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      run_date   TEXT NOT NULL,
      scenario   TEXT NOT NULL DEFAULT 'nitrosamine',
      data       JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (run_date, scenario)
    );

    CREATE TABLE IF NOT EXISTS lead_statuses (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      label       TEXT,
      color       TEXT,
      sort_order  INTEGER
    );

    CREATE TABLE IF NOT EXISTS users (
      id           SERIAL PRIMARY KEY,
      username     TEXT UNIQUE NOT NULL,
      display_name TEXT,
      email        TEXT,
      role         TEXT DEFAULT 'sales',
      created_at   TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS leads (
      id           SERIAL PRIMARY KEY,
      scenario     TEXT NOT NULL DEFAULT 'nitrosamine',
      api_name     TEXT NOT NULL,
      source       TEXT NOT NULL,
      reg_no       TEXT NOT NULL,
      sponsor      TEXT,
      drug_name    TEXT,
      status_id    INTEGER DEFAULT 1 REFERENCES lead_statuses(id),
      assigned_to  INTEGER REFERENCES users(id),
      priority     INTEGER DEFAULT 3,
      notes        TEXT,
      created_at   TIMESTAMP DEFAULT NOW(),
      updated_at   TIMESTAMP DEFAULT NOW(),
      UNIQUE(scenario, api_name, source, reg_no)
    );

    CREATE TABLE IF NOT EXISTS visit_records (
      id               SERIAL PRIMARY KEY,
      lead_id          INTEGER NOT NULL REFERENCES leads(id),
      visited_by       INTEGER REFERENCES users(id),
      visit_date       DATE,
      visit_type       TEXT,
      result           TEXT,
      notes            TEXT,
      next_action      TEXT,
      next_action_date DATE,
      created_at       TIMESTAMP DEFAULT NOW()
    );
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_trials_scenario_api ON trials(scenario, api_name);
    CREATE INDEX IF NOT EXISTS idx_trials_source ON trials(source);
    CREATE INDEX IF NOT EXISTS idx_search_state_lookup ON search_state(scenario, api_name, source);
    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status_id);
    CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads(assigned_to);
    CREATE INDEX IF NOT EXISTS idx_visit_records_lead ON visit_records(lead_id);
  `);
}

async function seedDefaults() {
  await client.query(`
    INSERT INTO lead_statuses (name, label, color, sort_order) VALUES
      ('new',       '新建',     '#3b82f6', 1),
      ('contacted', '已联系',   '#f59e0b', 2),
      ('visited',   '已拜访',   '#8b5cf6', 3),
      ('qualified', '已立项',   '#10b981', 4),
      ('won',       '已成交',   '#22c55e', 5),
      ('lost',      '已流失',   '#ef4444', 6)
    ON CONFLICT (name) DO NOTHING;
  `);
}

// ══════════════════════════════════════════════════
// API 元数据
// ══════════════════════════════════════════════════

async function getAPIs(scenario) {
  const res = await client.query(
    'SELECT name_en, name_cn, metadata, source_version, detected_at FROM apis WHERE scenario = $1 ORDER BY name_en',
    [scenario]
  );
  return res.rows;
}

async function getAPICount(scenario) {
  const res = await client.query(
    'SELECT COUNT(*) AS count FROM apis WHERE scenario = $1', [scenario]
  );
  return parseInt(res.rows[0].count);
}

async function getSourceVersion(scenario) {
  const res = await client.query(
    'SELECT DISTINCT source_version FROM apis WHERE scenario = $1 LIMIT 1', [scenario]
  );
  return res.rows.length > 0 ? res.rows[0].source_version : null;
}

async function upsertAPI(scenario, api) {
  await client.query(`
    INSERT INTO apis (scenario, name_en, name_cn, metadata, source_version, detected_at)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (scenario, name_en) DO UPDATE SET
      name_cn = EXCLUDED.name_cn,
      metadata = EXCLUDED.metadata,
      source_version = EXCLUDED.source_version,
      detected_at = EXCLUDED.detected_at,
      updated_at = NOW()
  `, [
    scenario,
    api.name_en,
    api.name_cn || null,
    JSON.stringify(api.metadata || {}),
    api.source_version || null,
    api.detected_at || null
  ]);
}

async function deleteAPIsNotInSet(scenario, names) {
  if (!names.length) return;
  await client.query(
    `DELETE FROM apis WHERE scenario = $1 AND name_en NOT IN (
      SELECT unnest($2::text[])
    )`,
    [scenario, names]
  );
}

// ══════════════════════════════════════════════════
// 搜索状态
// ══════════════════════════════════════════════════

async function getSearchState(scenario, apiName, source) {
  const res = await client.query(
    'SELECT last_cursor, lead_count, last_searched_at FROM search_state WHERE scenario = $1 AND api_name = $2 AND source = $3',
    [scenario, apiName, source]
  );
  if (res.rows.length === 0) {
    return { last_cursor: '', lead_count: 0, last_searched_at: null };
  }
  return res.rows[0];
}

async function ensureSearchState(scenario, apiName, source) {
  await client.query(`
    INSERT INTO search_state (scenario, api_name, source, last_cursor, lead_count)
    VALUES ($1, $2, $3, '', 0)
    ON CONFLICT (scenario, api_name, source) DO NOTHING
  `, [scenario, apiName, source]);
}

async function updateSearchState(scenario, apiName, source, updates) {
  await client.query(`
    INSERT INTO search_state (scenario, api_name, source, last_cursor, last_searched_at, lead_count)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (scenario, api_name, source) DO UPDATE SET
      last_cursor = EXCLUDED.last_cursor,
      last_searched_at = EXCLUDED.last_searched_at,
      lead_count = EXCLUDED.lead_count
  `, [
    scenario, apiName, source,
    updates.last_cursor !== undefined ? updates.last_cursor : '',
    updates.last_searched_at || new Date().toISOString().slice(0, 10),
    updates.lead_count !== undefined ? updates.lead_count : 0
  ]);
}

async function resetAllCursors(scenario, source) {
  if (source) {
    await client.query(
      `UPDATE search_state SET last_cursor = '' WHERE scenario = $1 AND source = $2`,
      [scenario, source]
    );
  } else {
    await client.query(
      `UPDATE search_state SET last_cursor = '' WHERE scenario = $1`,
      [scenario]
    );
  }
}

// ══════════════════════════════════════════════════
// 试验结果
// ══════════════════════════════════════════════════

async function getTrials(scenario, apiName) {
  const res = await client.query(
    `SELECT * FROM trials WHERE scenario = $1 AND api_name = $2 ORDER BY source, reg_no`,
    [scenario, apiName]
  );
  return res.rows.map(rowToTrial);
}

async function getTrialsBySource(scenario, apiName, source) {
  const res = await client.query(
    `SELECT * FROM trials WHERE scenario = $1 AND api_name = $2 AND source = $3 ORDER BY reg_no`,
    [scenario, apiName, source]
  );
  return res.rows.map(rowToTrial);
}

async function getExistingRegNos(scenario, apiName, source) {
  const res = await client.query(
    `SELECT reg_no FROM trials WHERE scenario = $1 AND api_name = $2 AND source = $3`,
    [scenario, apiName, source]
  );
  return new Set(res.rows.map(r => r.reg_no));
}

async function upsertTrial(scenario, trial) {
  await client.query(`
    INSERT INTO trials (
      scenario, api_name, source, reg_no, reg_date, sponsor, status,
      drug_name, dosage_form, drug_classification, trial_type,
      contact_name, contact_phone, contact_email, contact_address,
      pi_name, pi_unit, brief_title, official_title,
      target_enrollment, last_update_date, is_new
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
    )
    ON CONFLICT (scenario, api_name, source, reg_no) DO UPDATE SET
      reg_date = EXCLUDED.reg_date,
      sponsor = EXCLUDED.sponsor,
      status = EXCLUDED.status,
      drug_name = EXCLUDED.drug_name,
      dosage_form = EXCLUDED.dosage_form,
      drug_classification = EXCLUDED.drug_classification,
      trial_type = EXCLUDED.trial_type,
      contact_name = EXCLUDED.contact_name,
      contact_phone = EXCLUDED.contact_phone,
      contact_email = EXCLUDED.contact_email,
      contact_address = EXCLUDED.contact_address,
      pi_name = EXCLUDED.pi_name,
      pi_unit = EXCLUDED.pi_unit,
      brief_title = EXCLUDED.brief_title,
      official_title = EXCLUDED.official_title,
      target_enrollment = EXCLUDED.target_enrollment,
      last_update_date = EXCLUDED.last_update_date,
      is_new = EXCLUDED.is_new
  `, [
    scenario,
    trial.api_name || scenario,
    trial.source,
    trial.reg_no || trial.regNo,
    trial.reg_date || trial.regDate || '',
    trial.sponsor || '',
    trial.status || '',
    trial.drug_name || trial.drugName || '',
    trial.dosage_form || trial.dosageForm || '',
    trial.drug_classification || trial.drugClassification || '',
    trial.trial_type || trial.trialType || '',
    trial.contact_name || trial.contactName || '',
    trial.contact_phone || trial.contactPhone || '',
    trial.contact_email || trial.contactEmail || '',
    trial.contact_address || trial.contactAddress || '',
    trial.pi_name || trial.piName || '',
    trial.pi_unit || trial.piUnit || '',
    trial.brief_title || trial.briefTitle || '',
    trial.official_title || trial.officialTitle || '',
    trial.target_enrollment || trial.targetEnrollment || '',
    trial.last_update_date || trial.lastUpdateDate || '',
    trial.is_new || false
  ]);
}

async function batchUpsertTrials(scenario, trials) {
  if (!trials.length) return;
  const BATCH = 100;
  for (let i = 0; i < trials.length; i += BATCH) {
    const batch = trials.slice(i, i + BATCH);
    await client.query('BEGIN');
    for (const t of batch) {
      await upsertTrial(scenario, t);
    }
    await client.query('COMMIT');
  }
}

async function deleteTrialsBySource(scenario, apiName, source) {
  await client.query(
    `DELETE FROM trials WHERE scenario = $1 AND api_name = $2 AND source = $3`,
    [scenario, apiName, source]
  );
}

async function deleteAllTrialsBySource(scenario, source) {
  await client.query(
    `DELETE FROM trials WHERE scenario = $1 AND source = $2`,
    [scenario, source]
  );
}

async function countTrials(scenario) {
  const res = await client.query(
    'SELECT COUNT(*) AS count FROM trials WHERE scenario = $1', [scenario]
  );
  return parseInt(res.rows[0].count);
}

async function countTrialsBySource(scenario, source) {
  const res = await client.query(
    'SELECT COUNT(*) AS count FROM trials WHERE scenario = $1 AND source = $2',
    [scenario, source]
  );
  return parseInt(res.rows[0].count);
}

async function markTrialsNew(scenario, prevKeySet) {
  await client.query(
    `UPDATE trials SET is_new = true WHERE scenario = $1`,
    [scenario]
  );
  for (const key of prevKeySet) {
    const [source, regNo] = key.split('|');
    await client.query(
      `UPDATE trials SET is_new = false WHERE scenario = $1 AND source = $2 AND reg_no = $3`,
      [scenario, source, regNo]
    );
  }
}

// ══════════════════════════════════════════════════
// 快照
// ══════════════════════════════════════════════════

async function saveSnapshot(runDate, scenario, data) {
  await client.query(`
    INSERT INTO snapshots (run_date, scenario, data)
    VALUES ($1, $2, $3)
    ON CONFLICT (run_date, scenario) DO UPDATE SET data = EXCLUDED.data
  `, [runDate, scenario, JSON.stringify(data)]);
}

async function loadPrevSnapshot(todayDate, scenario) {
  const res = await client.query(
    `SELECT run_date, data FROM snapshots
     WHERE scenario = $1 AND run_date < $2
     ORDER BY run_date DESC LIMIT 1`,
    [scenario, todayDate]
  );
  if (res.rows.length === 0) return null;
  return { run_date: res.rows[0].run_date, data: res.rows[0].data };
}

// ══════════════════════════════════════════════════
// Lead 生命周期（Web App 用）
// ══════════════════════════════════════════════════

async function getLeadStatuses() {
  const res = await client.query('SELECT * FROM lead_statuses ORDER BY sort_order');
  return res.rows;
}

async function getUsers() {
  const res = await client.query('SELECT * FROM users ORDER BY display_name');
  return res.rows;
}

async function createUser(username, displayName, email, role) {
  const res = await client.query(
    `INSERT INTO users (username, display_name, email, role) VALUES ($1, $2, $3, $4) RETURNING id`,
    [username, displayName || null, email || null, role || 'sales']
  );
  return res.rows[0].id;
}

async function createLead(scenario, apiName, source, regNo, extra) {
  const res = await client.query(`
    INSERT INTO leads (scenario, api_name, source, reg_no, sponsor, drug_name)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (scenario, api_name, source, reg_no) DO UPDATE SET updated_at = NOW()
    RETURNING id
  `, [scenario, apiName, source, regNo, extra?.sponsor || null, extra?.drugName || null]);
  return res.rows[0].id;
}

async function updateLeadStatus(leadId, statusId) {
  await client.query(
    `UPDATE leads SET status_id = $1, updated_at = NOW() WHERE id = $2`,
    [statusId, leadId]
  );
}

async function assignLead(leadId, userId) {
  await client.query(
    `UPDATE leads SET assigned_to = $1, updated_at = NOW() WHERE id = $2`,
    [userId, leadId]
  );
}

async function getLeads(scenario, filters) {
  let sql = `
    SELECT l.*, s.name AS status_name, s.label AS status_label, s.color AS status_color,
           u.display_name AS assignee_name
    FROM leads l
    LEFT JOIN lead_statuses s ON l.status_id = s.id
    LEFT JOIN users u ON l.assigned_to = u.id
    WHERE l.scenario = $1
  `;
  const params = [scenario];
  let paramIdx = 2;
  if (filters?.status_id) {
    sql += ` AND l.status_id = $${paramIdx++}`;
    params.push(filters.status_id);
  }
  if (filters?.assigned_to) {
    sql += ` AND l.assigned_to = $${paramIdx++}`;
    params.push(filters.assigned_to);
  }
  sql += ` ORDER BY l.priority ASC, l.created_at DESC`;
  const res = await client.query(sql, params);
  return res.rows;
}

async function addVisitRecord(leadId, record) {
  const res = await client.query(`
    INSERT INTO visit_records (lead_id, visited_by, visit_date, visit_type, result, notes, next_action, next_action_date)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id
  `, [
    leadId,
    record.visited_by || null,
    record.visit_date || null,
    record.visit_type || null,
    record.result || null,
    record.notes || null,
    record.next_action || null,
    record.next_action_date || null
  ]);
  return res.rows[0].id;
}

async function getVisitRecords(leadId) {
  const res = await client.query(`
    SELECT v.*, u.display_name AS visitor_name
    FROM visit_records v
    LEFT JOIN users u ON v.visited_by = u.id
    WHERE v.lead_id = $1
    ORDER BY v.visit_date DESC, v.created_at DESC
  `, [leadId]);
  return res.rows;
}

// ══════════════════════════════════════════════════
// 辅助
// ══════════════════════════════════════════════════

function rowToTrial(row) {
  return {
    source: row.source,
    regNo: row.reg_no,
    regDate: row.reg_date,
    sponsor: row.sponsor,
    status: row.status,
    drugName: row.drug_name,
    dosageForm: row.dosage_form,
    drugClassification: row.drug_classification,
    trialType: row.trial_type,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    contactEmail: row.contact_email,
    contactAddress: row.contact_address,
    piName: row.pi_name,
    piUnit: row.pi_unit,
    briefTitle: row.brief_title,
    officialTitle: row.official_title,
    targetEnrollment: row.target_enrollment,
    lastUpdateDate: row.last_update_date,
    isNew: row.is_new
  };
}

module.exports = {
  init, close,
  getAPIs, getAPICount, getSourceVersion, upsertAPI, deleteAPIsNotInSet,
  getSearchState, ensureSearchState, updateSearchState, resetAllCursors,
  getTrials, getTrialsBySource, getExistingRegNos,
  upsertTrial, batchUpsertTrials, deleteTrialsBySource, deleteAllTrialsBySource,
  countTrials, countTrialsBySource, markTrialsNew,
  saveSnapshot, loadPrevSnapshot,
  getLeadStatuses, getUsers, createUser,
  createLead, updateLeadStatus, assignLead, getLeads,
  addVisitRecord, getVisitRecords
};
