#!/usr/bin/env node
/**
 * 智能表格同步 CLI（交付层运维工具）
 *
 * 用法：node scripts/wecom-sync.js <命令>
 *   init       创建正式智能表格（CSP商机跟踪）+ 全字段（一次性；幂等）
 *   status     打印当前表状态（字段数 / 记录数 / 反馈统计）
 *   feedback   导出反馈账本摘要（output/history/feedback.json）
 *   checkip    换网络/IP 漂移后自检（报 60020 时告诉你该把哪个 IP 加白名单）
 *
 * 日常同步不经过本 CLI：pipeline（scripts/run-pipeline.js）每次运行自动 sync。
 */

const path = require('path');
const W = require(path.join(__dirname, 'lib', 'wecom.js'));
const S = require(path.join(__dirname, 'lib', 'wecom-sheet.js'));

const log = (...a) => console.log(...a);

async function cmdInit() {
  const c = await S.initSheet();
  log(`docid=${c.docid}`);
  log(`sheet_id=${c.sheet_id}`);
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

const CMDS = { init: cmdInit, status: cmdStatus, feedback: cmdFeedback, checkip: cmdCheckIp };
const [cmd] = process.argv.slice(2);
(async () => {
  if (!CMDS[cmd]) { log('用法: node scripts/wecom-sync.js <init|status|feedback>'); process.exitCode = 1; return; }
  try { await CMDS[cmd](); } catch (e) { console.error(`\n❌ ${e.message}`); process.exitCode = 1; }
})();