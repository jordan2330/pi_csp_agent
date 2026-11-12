#!/usr/bin/env node
/**
 * 管线场景 —— D7 可联系性富化（CT.gov 公开联系渠道的**类型**）
 *
 * 合规边界（重要）：
 *   - CT.gov 使用条款禁止把库里的 email 用于营销/推广 → 本脚本**只记录渠道类型与企业域名**，
 *     不把个人姓名/电话/邮箱写进表格，也不写入任何报告。销售要看详情点「详情链接」自己看。
 *   - PIPL：个人联系方式不入表。
 *
 * 打分：3=有企业域邮箱 · 2=通用联络渠道（电话/公共邮箱）· 1=仅研究机构/负责人 · 0=无
 *
 * 用法：node scenarios/pipeline/enrich-contact.js [--limit N] [--recheck]
 */

const fs = require('fs');
const path = require('path');

const WS = path.resolve(__dirname, '..', '..');
const FILE = path.join(WS, 'output', 'history', 'pipeline-cde.json');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d; };
const LIMIT = arg('--limit', 1e9);
const CONC = arg('--concurrency', 5);
const RECHECK = process.argv.includes('--recheck');
const UA = { 'user-agent': 'pi-csp-agent/1.0 (internal sales-lead research)' };
const GENERIC_MAIL = /(gmail|163|126|qq|hotmail|outlook|yahoo|139|sina|foxmail)\.com$/i;
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function classify(proto) {
  const c = proto?.contactsLocationsModule || {};
  const contacts = c.centralContacts || [];
  const officials = c.overallOfficials || [];
  const mails = contacts.map(x => x.email).filter(Boolean);
  const corp = mails.map(m => String(m).split('@')[1] || '').filter(d => d && !GENERIC_MAIL.test(d));
  if (corp.length) return { d7: 3, hint: `企业域邮箱: ${[...new Set(corp)].slice(0, 2).join(', ')}` };
  if (mails.length || contacts.some(x => x.phone)) return { d7: 2, hint: '通用联络渠道（电话/公共邮箱）' };
  if (officials.length) return { d7: 1, hint: `仅研究机构/负责人（${(officials[0].affiliation || '机构未知').slice(0, 30)}）` };
  return { d7: 0, hint: '无公开联系渠道' };
}

(async () => {
  let store;
  try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { console.error(`❌ 读不到 ${path.relative(WS, FILE)}: ${e.message}`); process.exit(1); }
  const rows = Object.entries(store.rows || {});
  const byNct = new Map();
  for (const [k, r] of rows) {
    if (!r.nct) continue;
    if (typeof r.d7 === 'number' && !RECHECK) continue;
    if (!byNct.has(r.nct)) byNct.set(r.nct, []);
    byNct.get(r.nct).push(k);
  }
  const ncts = [...byNct.keys()].slice(0, LIMIT);
  log(`待查 NCT ${ncts.length}（总 ${byNct.size}），覆盖 ${ncts.reduce((n, x) => n + byNct.get(x).length, 0)} 行`);

  let done = 0, errors = 0;
  const dist = {};
  let next = 0;
  async function worker() {
    while (next < ncts.length) {
      const nct = ncts[next++];
      let res = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const u = `https://clinicaltrials.gov/api/v2/studies/${nct}?fields=NCTId,CentralContactName,CentralContactPhone,CentralContactEMail,OverallOfficialName,OverallOfficialAffiliation`;
          const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(20000) });
          if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
          res = classify((await r.json()).protocolSection);
          break;
        } catch (e) {
          if (attempt === 2) { errors++; if (errors <= 3) log(`  ⚠️ ${nct}: ${e.message}`); }
          else await sleep(1200);
        }
      }
      // 查询失败不落盘：留空下次自动重试（写 0 会被当成"已查过"永久卡住）
      if (res) {
        dist[res.d7] = (dist[res.d7] || 0) + 1;
        for (const k of byNct.get(nct)) {
          store.rows[k].d7 = res.d7;
          store.rows[k].contact_hint = res.hint;
        }
      }
      done++;
      if (done % 40 === 0) log(`  …${done}/${ncts.length}  D7分布 ${JSON.stringify(dist)}`);
      await sleep(250);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, ncts.length) }, () => worker()));
  log(`\n完成 ${done} 个 NCT，错误 ${errors} | D7 分布 ${JSON.stringify(dist)}`);

  store.contact_updated_at = new Date().toISOString();
  fs.writeFileSync(FILE, JSON.stringify(store, null, 1));

  const scoring = require('./scoring');
  const scored = Object.values(store.rows).map(r => ({ ...r, ...scoring.score({ drugName: r.drugName, company: r.company, regClass: r.regClass, phase: r.phase || '', regNo: r.regNo, d7: r.d7 }, { mode: 'full' }) }));
  log('档位:', JSON.stringify(scored.reduce((m, r) => (m[r.tier] = (m[r.tier] || 0) + 1, m), {})));
  log('有联系渠道(d7>=2)的行:', scored.filter(r => (r.dims?.D7 || 0) >= 2).length);
})().catch(e => { console.error('❌', e.message); process.exit(1); });