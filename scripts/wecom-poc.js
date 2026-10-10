#!/usr/bin/env node
/**
 * 企微智能表格 PoC —— 验证「表格即唯一交付物」的技术风险点
 *
 * 用法：node scripts/wecom-poc.js <命令> [参数]
 *   init                    创建 PoC 智能表格 + 字段（docid 存 config/wecom.json）
 *   schema                  打印字段与单选选项 ID
 *   seed [N=10] [ledger路径] 灌 N 行真实商机（默认读 output/history/ledger.json）
 *   dump [N=5]              打印记录（含最后编辑人/时间 —— 操作留痕验证）
 *   verify-update           核心验证：update_records 字段级合并（不覆盖反馈列）
 *   verify-user <userid>    验证人员字段写入 + 企微通知
 *   members <userid,userid> 把成员加为可编辑协作者
 *   webhook [key]           群机器人推送测试
 *
 * 前置（管理后台一次性，见 .env.example）：
 *   自建应用 + 「协作-文档-API」可调用应用 + 企业可信IP
 */

const fs = require('fs');
const path = require('path');
const W = require(path.join(__dirname, 'lib', 'wecom.js'));

const WS = path.resolve(__dirname, '..');
const DOC_NAME = 'CSP商机跟踪（PoC）';

// ── PoC 字段 schema：覆盖全部交付所需字段类型（正式版按最终列定义扩展）──
const CAT_OPTIONS = [
  { text: 'Cat1-极高风险', style: 18 }, { text: 'Cat2-高风险', style: 20 },
  { text: 'Cat3-中高风险', style: 21 }, { text: 'Cat4-中风险', style: 16 },
  { text: 'Cat5-低风险', style: 9 }
];
const STATUS_OPTIONS = [
  { text: '待跟进', style: 9 }, { text: '跟进中', style: 12 }, { text: '已联系', style: 16 },
  { text: '不感兴趣', style: 18 }, { text: '已转化', style: 19 }
];
const FIELDS = [
  { field_title: '商机键', field_type: 'FIELD_TYPE_TEXT' },                                        // source|regNo（与 ledger 对齐的 join 键）
  { field_title: '登记号', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '详情链接', field_type: 'FIELD_TYPE_URL', property_url: { type: 'LINK_TYPE_ICON_TEXT' } },
  { field_title: 'API', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '企业', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '剂型', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '风险等级', field_type: 'FIELD_TYPE_SINGLE_SELECT', property_single_select: { options: CAT_OPTIONS } },
  { field_title: '★新增', field_type: 'FIELD_TYPE_CHECKBOX' },
  { field_title: '登记日期', field_type: 'FIELD_TYPE_DATE_TIME', property_date_time: { format: 'yyyy-mm-dd' } },
  { field_title: '首次发现', field_type: 'FIELD_TYPE_DATE_TIME', property_date_time: { format: 'yyyy-mm-dd' } },
  // 反馈列（销售独占）
  { field_title: '跟进状态', field_type: 'FIELD_TYPE_SINGLE_SELECT', property_single_select: { options: STATUS_OPTIONS } },
  { field_title: '负责人', field_type: 'FIELD_TYPE_USER', property_user: { is_multiple: false, is_notified: true } },
  { field_title: '跟进备注', field_type: 'FIELD_TYPE_TEXT' },
  { field_title: '跟进日期', field_type: 'FIELD_TYPE_DATE_TIME', property_date_time: { format: 'yyyy-mm-dd' } },
  // 系统列（表格自动维护，API 不可写）——操作留痕
  { field_title: '创建人', field_type: 'FIELD_TYPE_CREATED_USER' },
  { field_title: '创建时间', field_type: 'FIELD_TYPE_CREATED_TIME', property_created_time: { format: 'yyyy-mm-dd hh:mm' } },
  { field_title: '最后编辑人', field_type: 'FIELD_TYPE_MODIFIED_USER' },
  { field_title: '最后编辑时间', field_type: 'FIELD_TYPE_MODIFIED_TIME', property_modified_time: { format: 'yyyy-mm-dd hh:mm' } }
];

const log = (...a) => console.log(...a);
const cfg = () => {
  const c = W.readCfg();
  if (!c.docid) throw new Error('尚未 init（config/wecom.json 不存在）——先跑 node scripts/wecom-poc.js init');
  return c;
};

/** 取字段定义并索引：{ title: field }；选项按 text 查找 */
async function fieldIndex() {
  const c = cfg();
  const { fields = [] } = await W.sheet.getFields(c.docid, c.sheet_id);
  const byTitle = {};
  for (const f of fields) byTitle[f.field_title] = f;
  return byTitle;
}
function optionOf(byTitle, fieldTitle, text) {
  const opts = byTitle[fieldTitle]?.property_single_select?.options || [];
  const opt = opts.find(o => o.text === text);
  if (!opt) throw new Error(`字段「${fieldTitle}」没有选项「${text}」（现有：${opts.map(o => o.text).join('/')}）`);
  return { id: opt.id, text: opt.text };
}

// ── init：创建表 + 字段（可选传自己的 userid 设为表格管理员）──
async function cmdInit(adminUserid) {
  const old = W.readCfg();
  if (old.docid) { log(`已存在表格: ${old.url}（如需重建，先删 config/wecom.json）`); return; }

  log('创建智能表格...');
  const doc = await W.sheet.createDoc(DOC_NAME, adminUserid ? [adminUserid] : []);
  const docid = doc.docid || doc.doc_id;
  const url = doc.url || `https://doc.weixin.qq.com/smartsheet/${docid}`;
  log(`docid: ${docid}`);

  const sheets = await W.sheet.getSheets(docid);
  const list = sheets.sheet_list || sheets.sheets || [];
  log(`默认子表: ${JSON.stringify(list.map(s => ({ id: s.sheet_id, title: s.title || s.sheet_title })))}`);
  const sheetId = list[0]?.sheet_id;
  if (!sheetId) throw new Error(`未取到子表ID，原始返回: ${JSON.stringify(sheets).slice(0, 500)}`);

  const def = await W.sheet.getFields(docid, sheetId);
  log(`默认字段（PoC 不清理，正式版会处理）: ${(def.fields || []).map(f => f.field_title).join(' / ') || '（无）'}`);

  log('添加字段...');
  const added = await W.sheet.addFields(docid, sheetId, FIELDS);
  log(`已添加 ${(added.fields || []).length} 个字段`);

  W.writeCfg({ docid, sheet_id: sheetId, url, created_at: new Date().toISOString() });
  log(`\n✅ 完成。表格链接（分享给测试成员，或先自己打开检查）:\n${url}`);
  log(`\n  下一步：node scripts/wecom-poc.js seed 10  /home/guoj01/agents/pi_csp_agent_v3/output/history/ledger.json`);
}

// ── schema：打印字段与选项 ──
async function cmdSchema() {
  const byTitle = await fieldIndex();
  for (const [title, f] of Object.entries(byTitle)) {
    const opts = f.property_single_select?.options;
    log(`${title}  [${f.field_type}]${opts ? '  选项: ' + opts.map(o => `${o.text}(${o.id})`).join(', ') : ''}`);
  }
}

// ── seed：从 ledger 灌真实数据 ──
async function cmdSeed(nArg, ledgerPath) {
  const n = parseInt(nArg || '10', 10);
  const file = ledgerPath || path.join(WS, 'output', 'history', 'ledger.json');
  const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = Object.entries(ledger.entries || {}).slice(0, n);
  if (!entries.length) throw new Error(`ledger 无数据: ${file}`);

  const byTitle = await fieldIndex();
  const cats = CAT_OPTIONS.map(o => o.text);
  const records = entries.map(([key, e], i) => {
    const values = {
      '商机键': W.V.text(key),
      '登记号': W.V.text(e.regNo),
      'API': W.V.text(e.api),
      '企业': W.V.text(e.sponsor),
      '风险等级': W.V.select(optionOf(byTitle, '风险等级', cats[i % cats.length])),   // PoC 假数据：轮转分配
      '★新增': true,
      '登记日期': W.V.date(e.regDate),
      '首次发现': W.V.date(e.first_seen)
    };
    if (e.source === 'CT.gov' && e.regNo) values['详情链接'] = W.V.url(e.regNo, `https://clinicaltrials.gov/study/${e.regNo}`);
    // 前 2 条预置反馈，模拟"销售已填写"，供 verify-update 验证不被覆盖
    if (i < 2) {
      values['跟进状态'] = W.V.select(optionOf(byTitle, '跟进状态', '跟进中'));
      values['跟进备注'] = W.V.text('销售输入-字段级合并验证');
      values['跟进日期'] = W.V.date(new Date());
    }
    return { values };
  });

  log(`写入 ${records.length} 行...`);
  const res = await W.sheet.addRecords(cfg().docid, cfg().sheet_id, records);
  log(`✅ 成功 ${res.length} 行。前 2 行已预置反馈值（跟进状态/备注），用于验证 pipeline 更新不覆盖销售输入。`);
  log('   注意：新建表可能自带几条空记录，可在表格 UI 里手动删掉。');
}

// ── dump：打印记录（含操作留痕）──
async function cmdDump(nArg) {
  const n = parseInt(nArg || '5', 10);
  const recs = await W.sheet.getRecords(cfg().docid, cfg().sheet_id);
  log(`共 ${recs.length} 条记录\n`);
  for (const r of recs.slice(0, n)) {
    const v = r.values || {};
    log(`[${r.record_id}] ${W.plain(v['商机键'])} | ${W.plain(v['API'])} | ${W.plain(v['风险等级'])} | 跟进=${W.plain(v['跟进状态']) || '—'} | 备注=${W.plain(v['跟进备注']) || '—'}`);
    log(`    创建: ${r.creator_name || '—'} @ ${r.create_time ? new Date(Number(r.create_time)).toLocaleString() : '—'}   最后编辑: ${r.updater_name || '—'} @ ${r.update_time ? new Date(Number(r.update_time)).toLocaleString() : '—'}`);
  }
}

// ── verify-update：字段级合并语义（本方案最关键的技术假设）──
async function cmdVerifyUpdate() {
  const c = cfg();
  const recs = await W.sheet.getRecords(c.docid, c.sheet_id);
  const rec = recs.find(r => W.plain(r.values?.['商机键']));
  if (!rec) throw new Error('表里没有数据，先跑 seed');
  const id = rec.record_id;
  const byTitle = await fieldIndex();
  const snap = (vals) => ({
    '商机键': W.plain(vals['商机键']), 'API': W.plain(vals['API']), '企业': W.plain(vals['企业']),
    '跟进状态': W.plain(vals['跟进状态']), '跟进备注': W.plain(vals['跟进备注'])
  });
  const before = snap(rec.values);

  log(`目标记录 ${id}：更新前 = ${JSON.stringify(before)}\n`);

  // 步骤1：模拟销售填写反馈列
  await W.sheet.updateRecords(c.docid, c.sheet_id, [{ record_id: id, values: {
    '跟进状态': W.V.select(optionOf(byTitle, '跟进状态', '跟进中')),
    '跟进备注': W.V.text(`销售输入-${Date.now()}`)
  } }]);
  const afterSales = (await W.sheet.getRecords(c.docid, c.sheet_id, {})).find(r => r.record_id === id);
  const salesNote = W.plain(afterSales.values['跟进备注']);
  log(`步骤1（销售填反馈）: 跟进=${W.plain(afterSales.values['跟进状态'])} 备注=${salesNote}`);

  // 步骤2：模拟 pipeline 只更新数据列（不传任何反馈列）
  const newCat = W.plain(afterSales.values['风险等级']) === 'Cat5-低风险' ? 'Cat1-极高风险' : 'Cat5-低风险';
  await W.sheet.updateRecords(c.docid, c.sheet_id, [{ record_id: id, values: {
    '风险等级': W.V.select(optionOf(byTitle, '风险等级', newCat))
  } }]);
  const afterPipe = (await W.sheet.getRecords(c.docid, c.sheet_id, {})).find(r => r.record_id === id);
  const s = snap(afterPipe.values);
  log(`步骤2（pipeline 只写数据列）: 风险等级=${W.plain(afterPipe.values['风险等级'])}`);

  // 判定：反馈列保留 = PASS；其它数据列保留 = PASS
  const checks = [
    ['销售备注未被覆盖', s['跟进备注'] === salesNote],
    ['跟进状态未被覆盖', s['跟进状态'] === '跟进中'],
    ['数据列(API)保留原值', s['API'] === before['API']],
    ['目标数据列已更新', W.plain(afterPipe.values['风险等级']) === newCat],
    ['最后编辑人已记录', !!afterPipe.updater_name && afterPipe.updater_name !== ''],
    ['最后编辑时间已变化', Number(afterPipe.update_time) > Number(rec.update_time)]
  ];
  log('');
  let pass = true;
  for (const [name, ok] of checks) { log(`${ok ? '✅' : '❌'} ${name}`); if (!ok) pass = false; }
  log(`\n${pass ? '✅ PASS —— update_records 是字段级合并，pipeline 与销售互不覆盖，方案成立' : '❌ FAIL —— 记录级覆盖，需改为「读-合并-写」或换写入策略'}`);
  if (!pass) process.exitCode = 1;
}

// ── verify-user：人员字段 + 企微通知 ──
async function cmdVerifyUser(userid) {
  if (!userid) throw new Error('用法: node scripts/wecom-poc.js verify-user <userid>');
  const c = cfg();
  const recs = await W.sheet.getRecords(c.docid, c.sheet_id);
  const rec = recs.find(r => W.plain(r.values?.['商机键']));
  await W.sheet.updateRecords(c.docid, c.sheet_id, [{ record_id: rec.record_id, values: {
    '负责人': W.V.user(userid)
  } }]);
  const after = (await W.sheet.getRecords(c.docid, c.sheet_id)).find(r => r.record_id === rec.record_id);
  const u = after.values['负责人'];
  log(`写入结果: ${JSON.stringify(u)}`);
  log(Array.isArray(u) && u[0]?.user_id === userid
    ? '✅ 人员字段写入成功 —— 检查该成员是否收到企微通知（is_notified=true），收到则通知链路成立'
    : '❌ 人员字段未写入成功（userid 是否正确？成员是否在应用可见范围内？）');
}

// ── members：加协作者 ──
async function cmdMembers(list) {
  if (!list) throw new Error('用法: node scripts/wecom-poc.js members <userid,userid>');
  const ids = list.split(',').map(s => s.trim()).filter(Boolean);
  await W.sheet.modMember(cfg().docid, ids.map(userid => ({ userid, auth: 7 })));
  log(`✅ 已把 ${ids.length} 个成员加为可编辑协作者（auth=7）。让 TA 从企微里打开表格链接验证编辑体验。`);
}

// ── webhook：群机器人推送 ──
async function cmdWebhook(key) {
  if (key) process.env.WECOM_WEBHOOK_KEY = key;
  await W.webhook.send(`**CSP 商机 Pipeline 测试推送**\n本次新增 <font color="info">3</font> 条商机\n> 打开表格: ${cfg().url || '（未 init）'}`);
  log('✅ 已发送。检查群消息。');
}

// ── CLI 入口 ──
const [cmd, ...args] = process.argv.slice(2);
const CMDS = {
  init: () => cmdInit(args[0]),
  schema: () => cmdSchema(),
  seed: () => cmdSeed(args[0], args[1]),
  dump: () => cmdDump(args[0]),
  'verify-update': () => cmdVerifyUpdate(),
  'verify-user': () => cmdVerifyUser(args[0]),
  members: () => cmdMembers(args[0]),
  webhook: () => cmdWebhook(args[0])
};
(async () => {
  if (!CMDS[cmd]) {
    log('用法: node scripts/wecom-poc.js <命令>\n  命令: ' + Object.keys(CMDS).join(' | '));
    log('详见文件头部注释。');
    process.exitCode = 1; return;
  }
  try { await CMDS[cmd](); } catch (e) { console.error(`\n❌ ${e.message}`); process.exitCode = 1; }
})();