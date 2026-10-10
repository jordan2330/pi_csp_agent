/**
 * 企业微信 API 客户端 —— 智能表格（唯一交付物的新形态）+ 群机器人推送
 *
 * 凭证（.env 或环境变量）：WECOM_CORPID / WECOM_SECRET（见 .env.example）
 * 运行时资源（init 后自动生成，gitignore）：
 *   config/wecom.json          { docid, sheet_id, url }
 *   config/.wecom_token.json   access_token 缓存（提前 5 分钟刷新）
 *
 * API 要点（对照 2026-01 官方文档）：
 *   - 记录值 value 格式：文本 [{type:'text',text}]、链接(URL字段) [{type:'url',text,link}]、
 *     单选/多选 [{id,text}]（id 必须来自字段已有选项）、日期 毫秒时间戳字符串、
 *     人员 [{user_id}]、复选框 bool、数字 double
 *   - get_records 每页最多 1000（不传 limit 也是 1000），返回记录含 creator_name/updater_name/update_time
 *     —— "谁在什么时候改了哪行" 是表格原生能力，无需自己记
 *   - update_records 按 record_id + values 更新：**未传的字段保留原值**（字段级合并）
 *     → pipeline 只写数据列，永不覆盖销售填写的反馈列（PoC verify-update 专门验证此语义）
 *   - 系统字段（创建/修改人、创建/修改时间）由表格自动维护，API 不可写
 *
 * 前置（管理后台一次性）：见 .env.example 注释
 */

const fs = require('fs');
const path = require('path');

const WS = path.resolve(__dirname, '..', '..');
const CFG_FILE = path.join(WS, 'config', 'wecom.json');
const TOKEN_FILE = path.join(WS, 'config', '.wecom_token.json');
const QYAPI = 'https://qyapi.weixin.qq.com/cgi-bin';

// ── .env 极简解析（无依赖）：KEY=VALUE，忽略注释与空行；已存在于环境变量的不覆盖 ──
function loadEnv(file = path.join(WS, '.env')) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (_) { /* 无 .env 时走环境变量 */ }
}

function cred() {
  loadEnv();
  const corpid = process.env.WECOM_CORPID, secret = process.env.WECOM_SECRET;
  if (!corpid || !secret) {
    throw new Error('缺少 WECOM_CORPID / WECOM_SECRET —— 复制 .env.example 为 .env 并填入（详见文件内注释）');
  }
  return { corpid, secret };
}

// ── 运行时资源（docid/sheet_id）：原子写，同 history.js 风格 ──
function readCfg() { try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch { return {}; } }
function writeCfg(cfg) {
  const tmp = CFG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CFG_FILE);
}

// ── access_token（缓存 + 提前 5 分钟刷新）──
async function getToken() {
  const cached = (() => { try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { return null; } })();
  if (cached && cached.expires_at - Date.now() > 5 * 60 * 1000) return cached.access_token;

  const { corpid, secret } = cred();
  const res = await fetch(`${QYAPI}/gettoken?corpid=${encodeURIComponent(corpid)}&corpsecret=${encodeURIComponent(secret)}`);
  const data = await res.json();
  if (data.errcode !== 0) throw new Error(`gettoken 失败: ${data.errcode} ${data.errmsg}（可信IP未配/凭证错误是常见原因）`);
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in || 7200) * 1000
  }));
  return data.access_token;
}

// ── 通用请求：errcode 非 0 一律抛错（含 errcode/errmsg，便于定位可信IP等问题）──
async function api(pathname, body = null) {
  const token = await getToken();
  const url = `${QYAPI}${pathname}${pathname.includes('?') ? '&' : '?'}access_token=${token}`;
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000)
  });
  const data = await res.json();
  if (data.errcode !== 0) throw new Error(`${pathname} 失败: ${data.errcode} ${data.errmsg}`);
  return data;
}

// ── 记录值构造器（写到智能表格的 value 必须严格符合字段类型）──
const V = {
  text: (s) => (s == null || s === '') ? [] : [{ type: 'text', text: String(s) }],
  url: (text, link) => [{ type: 'url', text: String(text || link), link }],
  date: (d) => (d == null || d === '') ? '' : String(new Date(d).getTime()), // 毫秒时间戳字符串
  select: (opt) => opt ? [{ id: opt.id, text: opt.text }] : [],              // opt 来自 getFields 的 options
  user: (userid) => (userid ? [{ user_id: userid }] : []),
  checkbox: (b) => !!b
};
// 从 getRecords 返回值中提取纯文本（值可能是 [{type:'text',text}] / [{text}] / 原始值）
function plain(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(x => x.text ?? x.id ?? x.user_id ?? '').join(' ');
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

// ── 智能表格操作 ──
const sheet = {
  /** 新建智能表格（doc_type=10）；admin_users 传 userid 列表可直接设为管理员 */
  createDoc: (docName, adminUsers = []) => api('/wedoc/create_doc', {
    doc_type: 10, doc_name: docName, ...(adminUsers.length ? { admin_users: adminUsers } : {})
  }),
  getSheets: (docid) => api('/wedoc/smartsheet/get_sheet', { docid }),
  getFields: (docid, sheetId) => api('/wedoc/smartsheet/get_fields', { docid, sheet_id: sheetId }),
  addFields: (docid, sheetId, fields) => api('/wedoc/smartsheet/add_fields', { docid, sheet_id: sheetId, fields }),
  updateFields: (docid, sheetId, fields) => api('/wedoc/smartsheet/update_fields', { docid, sheet_id: sheetId, fields }),
  /** 单次 ≤500 行（官方建议）；超出自动分批 */
  addRecords: (docid, sheetId, records) => batchCall('/wedoc/smartsheet/add_records', docid, sheetId, records, 500),
  updateRecords: (docid, sheetId, records) => batchCall('/wedoc/smartsheet/update_records', docid, sheetId, records, 500),
  /** 全量拉取（自动翻页，每页 1000） */
  async getRecords(docid, sheetId, { fieldTitles, viewId } = {}) {
    const out = [];
    let offset = 0;
    for (;;) {
      const data = await api('/wedoc/smartsheet/get_records', {
        docid, sheet_id: sheetId, key_type: 'CELL_VALUE_KEY_TYPE_FIELD_TITLE',
        ...(fieldTitles ? { field_titles: fieldTitles } : {}),
        ...(viewId ? { view_id: viewId } : {}),
        offset, limit: 1000
      });
      out.push(...(data.records || []));
      if (!data.has_more || !(data.records || []).length) break;
      offset = data.next != null ? data.next : offset + (data.records || []).length;
    }
    return out;
  },
  /** 文档成员管理：update 列表元素 { userid, auth }（auth 7=可编辑，见 doc_get_auth 文档） */
  modMember: (docid, updateFileMemberList) => api('/wedoc/mod_doc_member', {
    docid, update_file_member_list: updateFileMemberList.map(m => ({ type: 1, ...m }))
  })
};

async function batchCall(pathname, docid, sheetId, records, size) {
  const results = [];
  for (let i = 0; i < records.length; i += size) {
    const data = await api(pathname, {
      docid, sheet_id: sheetId, key_type: 'CELL_VALUE_KEY_TYPE_FIELD_TITLE',
      records: records.slice(i, i + size)
    });
    results.push(...(data.records || []));
  }
  return results;
}

// ── 群机器人推送（webhook key 认证，不占可信 IP、零管理后台配置）──
const webhook = {
  async send(content, { key = process.env.WECOM_WEBHOOK_KEY, msgtype = 'markdown' } = {}) {
    if (!key) throw new Error('缺少 WECOM_WEBHOOK_KEY（.env 或参数）');
    const res = await fetch(`${QYAPI}/webhook/send?key=${key}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype, [msgtype]: { content } }), signal: AbortSignal.timeout(15000)
    });
    const data = await res.json();
    if (data.errcode !== 0) throw new Error(`webhook 发送失败: ${data.errcode} ${data.errmsg}`);
    return data;
  }
};

module.exports = { api, getToken, cred, loadEnv, readCfg, writeCfg, sheet, webhook, V, plain, CFG_FILE };