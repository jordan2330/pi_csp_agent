#!/usr/bin/env node
/**
 * 智能表格同步 CLI（交付层运维工具）
 *
 * 用法：node scripts/wecom-sync.js <命令> [参数]
 *   init              创建正式智能表格（CSP商机跟踪）+ 全字段（一次性；幂等）
 *   reorder           按 SCHEMA 顺序重建字段（改字段顺序后用；会清空数据列，需再接 sync）
 *   sync [场景=nitrosamine]  用 output/runs/ 最新快照手动同步一次（排查/补跑用；日常由 pipeline 自动调）
 *   status            打印当前表状态（字段数 / 记录数 / 反馈统计）
 *   feedback          导出反馈账本摘要（output/history/feedback.json）
 *   checkip           换网络/IP 漂移后自检（报 60020 时告诉你该把哪个 IP 加白名单）
 *
 * 日常同步不经过本 CLI：pipeline（scripts/run-pipeline.js）每次运行自动 sync。
 */

const fs = require('fs');
const path = require('path');
const W = require(path.join(__dirname, 'lib', 'wecom.js'));
const S = require(path.join(__dirname, 'lib', 'wecom-sheet.js'));

const WS = path.resolve(__dirname, '..');

const log = (...a) => console.log(...a);

async function cmdInit() {
  const c = await S.initSheet();
  log(`docid=${c.docid}`);
  log(`sheet_id=${c.sheet_id}`);
}

async function cmdSync(scenarioName = 'nitrosamine') {
  const runsDir = path.join(WS, 'output', 'runs');
  const files = fs.readdirSync(runsDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const latest = files[files.length - 1];
  if (!latest) throw new Error('output/runs/ 下无快照 —— 先跑一次 pipeline');
  const snap = JSON.parse(fs.readFileSync(path.join(runsDir, latest), 'utf8'));
  const scenarioDir = path.join(WS, 'scenarios', scenarioName);
  const config = JSON.parse(fs.readFileSync(path.join(scenarioDir, 'scenario.json'), 'utf8'));
  const hooks = require(path.join(scenarioDir, 'enrich.js'));
  log(`用快照 ${latest} 同步（场景 ${scenarioName}）...`);
  const now = new Date();
  const r = await S.sync(snap, { name: scenarioName, dir: scenarioDir, config, hooks }, false, {
    run: `${now.toISOString().slice(0, 16).replace('T', ' ')} (手动)`,
    date: now.toISOString().slice(0, 10)
  });
  log(`表内新增 ${r.added} 行 / 更新 ${r.updated} 行 | 累积 ${r.rows} 行（窗口内 ${r.activeRows}）| ★ ${r.newRows} | 反馈变化 ${r.fbChanges} 条`);
  log(`表格: ${r.url}`);
}

async function cmdReorder() {
  const c = W.readCfg();
  if (!c.docid) throw new Error('尚未初始化，先跑 init');
  const { fields = [] } = await W.sheet.getFields(c.docid, c.sheet_id);
  const mainTitle = S.SCHEMA[0].field_title;   // 主字段（不可删）
  const others = fields.filter(f => f.field_title !== mainTitle);
  if (others.length) {
    await W.sheet.deleteFields(c.docid, c.sheet_id, others.map(f => f.field_id));
    log(`已删除 ${others.length} 个旧字段（数据列清空，随后 sync 回填）`);
  }
  // add_fields 为前插 → 按期望顺序倒序添加，使 UI 左→右 = SCHEMA 顺序
  const ordered = S.SCHEMA.filter(f => f.field_title !== mainTitle).slice().reverse();
  await W.sheet.addFields(c.docid, c.sheet_id, ordered);
  const after = (await W.sheet.getFields(c.docid, c.sheet_id)).fields || [];
  log(`✅ 已按销售视角顺序重建 ${ordered.length} 个字段`);
  log('当前字段顺序（应即 UI 左→右）: ');
  log('  ' + after.map(f => f.field_title).join(' → '));
  log('→ 接着跑：node scripts/wecom-sync.js sync 重新灌入数据');
}

async function cmdStatus() {
  const c = W.readCfg();
  if (!c.docid) throw new Error('尚未初始化，先跑 init');
  const { fields = [] } = await W.sheet.getFields(c.docid, c.sheet_id);
  const recs = await W.sheet.getRecords(c.docid, c.sheet_id);
  const w = W.plain;
  const fb = recs.filter(r => w(r.values['跟进状态']) || w(r.values['跟进备注']) || (r.values['负责人'] || []).length);
  const byStatus = {};
  fb.forEach(r => { const s = w(r.values['跟进状态']) || '（未填状态）'; byStatus[s] = (byStatus[s] || 0) + 1; });
  log(`表格: ${c.url}`);
  log(`字段: ${fields.length} 个 | 记录: ${recs.length} 条 | 有反馈: ${fb.length} 条`);
  Object.entries(byStatus).forEach(([s, n]) => log(`   ${s}: ${n}`));
}

function cmdFeedback() {
  const fb = S.loadFeedback();
  const cur = Object.entries(fb.current || {});
  log(`反馈账本: ${cur.length} 条当前值 | ${(fb.history || []).length} 条历史事件`);
  cur.slice(0, 20).forEach(([k, v]) => log(`[${k}] ${v.status || '—'} | ${v.owner || '—'} | ${v.note || '—'} | ${v.fdate || '—'} | by ${v.by} @ ${v.at}`));
}

// 企微直连（国内域名不走代理），出口 IP 会随网络/重拨变化；报 60020 时用本命令查出该加白名单的 IP
async function cmdCheckIp() {
  const { corpid, secret } = W.cred();
  const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpid)}&corpsecret=${encodeURIComponent(secret)}`);
  const data = await res.json();
  if (data.errcode === 0) { log('✅ gettoken 成功 —— 当前出口 IP 已在企业可信IP白名单内'); return; }
  log(`❌ gettoken 失败: ${data.errcode} ${data.errmsg}`);
  const m = String(data.errmsg || '').match(/from ip: ([0-9.]+)/);
  if (m) {
    log(`\n当前企微看到的出口 IP 是: ${m[1]}`);
    log('→ 管理后台：应用管理 → 你的应用 → 页面底部「企业可信IP」→ 加上这个 IP（分号分隔，可填多个，上限 120）');
  }
}

const CMDS = { init: cmdInit, reorder: cmdReorder, sync: cmdSync, status: cmdStatus, feedback: cmdFeedback, checkip: cmdCheckIp };
const [cmd, ...args] = process.argv.slice(2);
(async () => {
  if (!CMDS[cmd]) { log('用法: node scripts/wecom-sync.js <init|reorder|sync|status|feedback|checkip> [场景]'); process.exitCode = 1; return; }
  try { await CMDS[cmd](...args); } catch (e) { console.error(`\n❌ ${e.message}`); process.exitCode = 1; }
})();