#!/usr/bin/env node
/**
 * 管线交易周报：从事件账本聚合最近 N 天，推企微群
 *
 * 设计原则：
 *   ① 只 prod 推送（dev 只打印，避免开发机往销售群发假周报——与主表同一纪律）
 *   ② 顶部带健康度（抓了多少条/过闸多少/抽出多少）——数字异常（如 0）一眼看出源或 Key 挂了
 *   ③ 排序：有金额 > 已在资产表 > 中国权益保留 > 日期新
 *
 * 用法：
 *   node scenarios/preclinical/digest.js                 # 最近 7 天；dev 只打印
 *   node scenarios/preclinical/digest.js --days 14 --send # 强制推送（含 dev，慎用）
 */

const fs = require('fs');
const path = require('path');

const WS = path.resolve(__dirname, '..', '..');
const W = require(path.join(WS, 'scripts', 'lib', 'wecom.js'));
W.loadEnv();
process.env.WECOM_TABLE = 'preclinical';

const events = require('./lib/events');
const { match } = require('./lib/match');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d; };
const DAYS = arg('--days', 7);
const FORCE = process.argv.includes('--send');

const TYPE_CN = { license_out: '授权出海', license_in: '引进', financing: '融资', milestone: '里程碑', partnership: '合作', other: '其他' };
const money = (m) => (m ? `${m >= 1000 ? (m / 1000).toFixed(2) + '十亿' : m}M` : '');

function rank(e) {
  let s = 0;
  if (e.amount_total_usd_m || e.amount_upfront_usd_m) s += 4;
  if (match(e).hit === '是') s += 3;
  if (e.china_rights === 'retained') s += 1;
  if (e.territory_scope === 'ex_greater_china' || e.territory_scope === 'global') s += 1;
  return s;
}

function line(e) {
  const who = e.company_raw ? `${e.company_raw}${e.counterparty_raw ? ' × ' + e.counterparty_raw : ''}` : (e.counterparty_raw || '未知');
  const amt = [e.amount_upfront_usd_m ? `首付 ${money(e.amount_upfront_usd_m)}` : '', e.amount_total_usd_m ? `总额 ${money(e.amount_total_usd_m)}` : ''].filter(Boolean).join(' / ') || e.amount_total_raw || '';
  const hit = match(e).hit === '是' ? ' 🔁' : '';                       // 🔁 = 已在资产表（老客户/在跟品种）
  const bits = [TYPE_CN[e.type] || e.type, who, e.asset_raw || '', e.phase_raw || '', amt].filter(Boolean);
  return `- ${bits.join('｜')}${hit}${e.one_liner ? `\n  > ${e.one_liner}` : ''}`;
}

(async () => {
  const year = new Date().getFullYear();
  const all = [...Object.values(events.load(year - 1).events), ...Object.values(events.load(year).events)];
  const since = new Date(Date.now() - DAYS * 864e5).toISOString().slice(0, 10);
  const fresh = all.filter(e => (e.date || '') >= since);

  const runsFile = path.join(WS, 'output', 'history', 'preclinical', 'runs.json');
  const runs = (() => { try { return JSON.parse(fs.readFileSync(runsFile, 'utf8')); } catch { return []; } })();
  const recentRuns = runs.filter(r => (r.at || '').slice(0, 10) >= since);
  const st = recentRuns.reduce((m, r) => ({
    raw: m.raw + (r.raw || 0), fresh: m.fresh + (r.fresh || 0),
    candidates: m.candidates + (r.candidates || 0), valid: m.valid + (r.valid || 0)
  }), { raw: 0, fresh: 0, candidates: 0, valid: 0 });

  const cfg = W.readCfg();
  const url = cfg.url || '';
  const top = fresh.slice().sort((a, b) => rank(b) - rank(a) || String(b.date).localeCompare(String(a.date))).slice(0, 8);
  const inBook = fresh.filter(e => match(e).hit === '是').length;

  let health = `抓取 ${st.raw} ｜ 过闸 ${st.candidates} ｜ 事件 ${st.valid}`;
  if (!recentRuns.length) health = '本周尚无运行档案（run.js 还没跑过）';
  else if (st.raw === 0) health = '⚠️ **本周没有抓到任何内容** —— 检查 wechat2RSS / cninfo / API Key';
  else if (st.valid === 0) health = `⚠️ 抓了 ${st.raw} 条，但一条事件都没抽出来 —— 检查模型/Key`;

  const md = [
    `**管线交易周报 ${since} ~ ${new Date().toISOString().slice(0, 10)}**`,
    `本周新增 <font color="info">${fresh.length}</font> 条 ｜ 命中已有资产 <font color="warning">${inBook}</font> 条`,
    `> ${health}`,
    '',
    ...(top.length ? top.map(line) : ['本周无新增事件']),
    '',
    `> [打开「管线交易信息」](${url})`,
    `> 🔁 = 该公司/资产已在「临床阶段管线」里`
  ].join('\n');

  console.log(md);
  const env = W.envOf();
  if (!FORCE && env !== 'prod') { console.log(`\n（WECOM_ENV=${env}，仅打印不推送；要强推 --send）`); return; }
  if (!process.env.WECOM_WEBHOOK_KEY) { console.log('\n（未配 WECOM_WEBHOOK_KEY，跳过推送）'); return; }
  await W.webhook.send(md);
  console.log('\n✅ 已推送到企微群');
})().catch(e => { console.error('❌', e.message); process.exit(1); });