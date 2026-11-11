#!/usr/bin/env node
/**
 * 管线场景 —— 给「公司×资产」行挂期次（D3）
 *
 * 为什么按药品代号查 CT.gov 而不是按企业查：
 *   ① CT.gov 只索引英文申办方名（中文实测 0 命中），按企业查需要英文别名表；
 *   ② D3 要的是「资产处于几期」，按药品名/代号查天然是资产级，不依赖企业名对齐。
 *
 * 只查药品名里带英文/数字代号的（HRS-2329、N2103、MRO-001HS…）；纯中文名留给 CDT 检索。
 * 用法：
 *   node scenarios/pipeline/enrich-phase.js --limit 60        # 先试 60 个代号
 *   node scenarios/pipeline/enrich-phase.js                   # 全部
 */

const fs = require('fs');
const path = require('path');

const WS = path.resolve(__dirname, '..', '..');
const FILE = path.join(WS, 'output', 'history', 'pipeline-cde.json');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d; };
const LIMIT = arg('--limit', 1e9);
const UA = { 'user-agent': 'pi-csp-agent/1.0 (internal sales-lead research)' };
const log = (...a) => console.log(...a);

// 代号提取：HRS-2329 / N2103 / RO7795068 / MRO-001HS / EP-0330SP / APG-3288
const codeOf = (drugName) => {
  const s = String(drugName || '');
  const m = s.match(/[A-Za-z]{1,6}[-‐]?\d{2,8}[A-Za-z]{0,4}|[A-Za-z]{3,}[-‐][A-Za-z0-9]{2,}/);
  return m ? m[0].replace(/[-‐]$/, '') : null;
};
const rank = (p) => /PHASE3/i.test(p) ? 3 : /PHASE2/i.test(p) ? 2 : /PHASE1|EARLY_PHASE1/i.test(p) ? 1 : 0;
const phaseLabel = (r) => r === 3 ? 'III期' : r === 2 ? 'II期' : r === 1 ? 'I期' : '';

(async () => {
  let store;
  try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { console.error(`❌ 无法读取 ${path.relative(WS, FILE)}: ${e.message}（先跑 sources-cde.js）`); process.exit(1); }
  const rows = Object.entries(store.rows || {});
  const byCode = new Map();                    // code → [keys]
  for (const [k, r] of rows) {
    const c = codeOf(r.drugName);
    if (!c) continue;
    if (!byCode.has(c)) byCode.set(c, []);
    byCode.get(c).push(k);
  }
  const codes = [...byCode.keys()].slice(0, LIMIT);
  log(`待查代号 ${codes.length}（总 ${byCode.size}），覆盖 ${codes.reduce((n, c) => n + byCode.get(c).length, 0)} 行`);

  let hit = 0, done = 0, errors = 0;
  for (const code of codes) {
    let best = null;
    try {
      const u = `https://clinicaltrials.gov/api/v2/studies?query.term=${encodeURIComponent(code)}`
        + `&pageSize=30&fields=NCTId,Phase,LeadSponsorName,StudyFirstPostDate,InterventionName,BriefTitle`;
      const res = await fetch(u, { headers: UA, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const studies = (j.studies || []).map(s => s.protocolSection || {});
      // 精确性关键：query.term 是全文检索，会把「别人家的同阶段试验」一起带回来 →
      // 必须要求代号出现在本试验的干预名/标题里，否则期次会被系统性高估（实测 HRS-7058 被抬到 III 期）
      const norm = (x) => String(x || '').toLowerCase().replace(/[-‐_\s]/g, '');
      const codeN = norm(code);
      const relevant = studies.filter(s => {
        const iv = (s.armsInterventionsModule?.interventions || []).map(i => i.name).join(' ');
        const ti = s.identificationModule?.briefTitle || '';
        return norm(iv).includes(codeN) || norm(ti).includes(codeN);
      });
      let maxRank = 0, ncts = [], sponsors = new Set();
      for (const s of relevant) {
        const ph = (s.designModule?.phases || []).join(',');
        const r = rank(ph);
        if (r > maxRank) maxRank = r;
        if (r > 0 && ncts.length < 3) ncts.push(s.identificationModule?.nctId);
        const sp = s.sponsorCollaboratorsModule?.leadSponsor?.name;
        if (sp) sponsors.add(sp);
      }
      best = { rank: maxRank, ncts: ncts.filter(Boolean), total: relevant.length, sponsors: [...sponsors].slice(0, 3) };
    } catch (e) {
      errors++;
      if (errors <= 3) log(`  ⚠️ ${code}: ${e.message}`);
    }
    if (best && best.rank > 0) hit++;
    for (const k of byCode.get(code)) {
      store.rows[k].phase = best ? phaseLabel(best.rank) : '';
      store.rows[k].phase_rank = best ? best.rank : 0;
      store.rows[k].phase_src = best && best.rank ? 'CT.gov(干预名精确)' : '';
      store.rows[k].nct = best ? (best.ncts[0] || '') : '';
    }
    done++;
    if (done % 20 === 0) log(`  …${done}/${codes.length}  命中 ${hit}  错误 ${errors}`);
    await new Promise(r => setTimeout(r, 1200));     // CT.gov 自律限速
  }
  log(`\n查询完成：${done} 个代号，命中期次 ${hit}（${(100 * hit / Math.max(1, done)).toFixed(0)}%），错误 ${errors}`);

  store.phase_updated_at = new Date().toISOString();
  fs.writeFileSync(FILE, JSON.stringify(store, null, 1));

  // 挂完期次再看档位
  const scoring = require('./scoring');
  const scored = Object.values(store.rows).map(r => {
    const s = scoring.score({ drugName: r.drugName, regClass: r.regClass, phase: r.phase || '' });
    return { ...r, ...s };
  });
  const dist = scored.reduce((m, r) => (m[r.tier] = (m[r.tier] || 0) + 1, m), {});
  const d3 = scored.reduce((m, r) => (m[r.dims.D3 || 0] = (m[r.dims.D3 || 0] || 0) + 1, m), {});
  log('档位:', JSON.stringify(dist), '| D3 分布:', JSON.stringify(d3));
  log('\nA/B 档样例（前 12）:');
  scored.filter(r => !r.excluded && (r.tier === 'A' || r.tier === 'B')).sort((a, b) => b.points - a.points).slice(0, 12)
    .forEach(r => log(` ${r.tier} ${r.points} ${r.drugName.slice(0, 20).padEnd(22)} ${r.company.slice(0, 22).padEnd(24)} ${r.regClass||'-'} ${r.phase || '-'}`));
})().catch(e => { console.error('❌', e.message); process.exit(1); });