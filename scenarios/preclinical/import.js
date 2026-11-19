#!/usr/bin/env node
/**
 * 历史补录 —— 把外部调研结果（人工/subagent 网络检索）导入事件账本
 *
 * 用法：
 *   node scenarios/preclinical/import.js --file /tmp/research-bd.json [--file b.json] [--dry-run]
 *
 * 与采集链的区别只在来源：**同一套账本、同一套 EVT 键与去重**，表里看不出差异
 * （`source_type: research` 留存溯源）。
 *
 * 硬性校验（防编造）：每次导入都抓 URL 原文做引句回文校验（复用 extract.quoteOk，
 * 严格子串 → 退化为 4-gram 重叠 ≥0.7）。对不上 → needs_review，**不入库**。
 */

const fs = require('fs');
const path = require('path');
const WS = path.resolve(__dirname, '..', '..');
const events = require('./lib/events');
const { quoteOk } = require('./lib/extract');
const { htmlToText } = require('./lib/text');

const has = (f) => process.argv.includes(f);
const files = process.argv.reduce((a, v, i, arr) => (v === '--file' ? [...a, arr[i + 1]] : a), []);
const DRY = has('--dry-run');

const TYPES = ['license_out', 'license_in', 'financing', 'milestone', 'cooperation', 'other'];
const PHASES = ['临床前', 'IND', 'I期', 'II期', 'III期', 'NDA/上市'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const USD = 7.2;          // 人民币→美元固定汇率：只用于排序/展示，原文永远保留

/** "最高12亿美元" → 1200；"3亿元人民币" → 42；"5000万美元" → 50 */
function toUsdM(raw) {
  const s = String(raw || '').replace(/[,，]/g, '');
  const m = s.match(/([\d.]+)\s*(亿|百万|万)?\s*(美元|美金|人民币|RMB|元)/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  if (m[2] === '亿') n *= 100; else if (m[2] === '万') n /= 100;
  if (!/美元|美金|USD/i.test(m[3])) n /= USD;      // 注意「美元」里也含「元」：先判美元，再当人民币
  return n > 0 && n < 200000 ? Math.round(n * 10) / 10 : null;
}

const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0 Safari/537.36', 'accept-language': 'zh-CN,zh;q=0.9' };

async function fetchText(url) {
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(25000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return htmlToText(await r.text());
    } catch (e) { if (i) throw e; await new Promise(r => setTimeout(r, 1500)); }
  }
}

if (require.main === module) (async () => {
  if (!files.length) { console.error('用法：node scenarios/preclinical/import.js --file <json> [--file ...] [--dry-run]'); process.exit(1); }
  const raw = files.flatMap(f => { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(j) ? j : (j.events || []); });
  console.log(`待校验 ${raw.length} 条（${files.length} 个文件）${DRY ? ' [dry-run]' : ''}`);

  const dbs = {};
  const dbOf = (y) => (dbs[y] ||= events.load(y));
  const accepted = [], rejected = [];

  for (const [i, r] of raw.entries()) {
    const miss = [];
    const type = TYPES.includes(r.type) ? r.type : (r.type === 'bd' ? 'license_out' : 'other');
    if (!r.company_cn || String(r.company_cn).trim().length < 2) miss.push('无公司名');
    if (!DATE_RE.test(String(r.event_date || ''))) miss.push('日期非 YYYY-MM-DD');
    if (!/^https?:\/\//.test(String(r.url || ''))) miss.push('无 URL');
    if (String(r.evidence_quote || '').length < 8) miss.push('引句过短');
    if (miss.length) { rejected.push({ r, why: miss.join('/') }); continue; }

    const key = `${String(r.company_cn).trim()}|${r.asset_raw || '-'}|${type}|${r.event_date}`;
    let text;
    try { text = await fetchText(r.url); } catch (e) { rejected.push({ r, why: `抓取失败 ${e.message.slice(0, 30)}` }); continue; }
    if (!quoteOk(r.evidence_quote, text)) {
      rejected.push({ r, why: '引句对不上原文（疑似编造/转载改写过）' });
      console.log(`  ✗ [${i + 1}/${raw.length}] ${r.company_cn} ${r.event_date} — 引句校验失败`);
      continue;
    }

    const ev = {
      is_event: true,
      type,
      company_cn: String(r.company_cn).trim(),
      company_raw: String(r.company_cn).trim(),
      counterparty_raw: r.counterparty_raw || '',
      asset_raw: r.asset_raw || '',
      phase_raw: PHASES.includes(r.phase_raw) ? r.phase_raw : '',
      amount_upfront_raw: r.amount_upfront_raw || '',
      amount_upfront_usd_m: toUsdM(r.amount_upfront_raw),
      amount_total_raw: r.amount_total_raw || '',
      amount_total_usd_m: toUsdM(r.amount_total_raw),
      territory_raw: r.territory_raw || '',
      territory_scope: 'unknown',          // 授权范围枚举由 LLM 判，导入侧只保留原文（宁缺勿推）
      china_rights: 'unknown',
      counterparty_type: '其他',
      therapeutic_area: '未知',
      one_liner: r.one_liner || '',
      event_date: r.event_date,
      date: r.event_date,
      evidence_quote: r.evidence_quote,
      confidence: 0.7,
      ok: true,
      needs_review: false,
      review_why: '',
      source_type: 'research',             // 与自动采集（rss/cninfo/gnews）区分
      sources: [{ title: r.source_title || r.one_liner || '', url: r.url, source: r.source_name || 'research', also: [], published: r.event_date }],
      extracted_by: `research@${new Date().toISOString().slice(0, 10)}`
    };
    if (!DRY) {
      const y = Number(r.event_date.slice(0, 4));
      const db = dbOf(y);
      const res = events.upsert(db, ev);
      console.log(`  ✓ [${i + 1}/${raw.length}] ${res.action === 'added' ? '新增' : '合并'} ${key}`);
    }
    accepted.push({ ev, key });
  }

  if (!DRY) for (const [y, db] of Object.entries(dbs)) events.save(Number(y), db);
  console.log(`\n通过 ${accepted.length} / 拒绝 ${rejected.length}`);

  // 复核清单：拒绝原因 + 疑似跨月重复（同公司+资产+类型，非合并窗口内）
  const outDir = path.join(WS, 'output', 'preclinical');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `import-review-${new Date().toISOString().slice(0, 10)}.md`);
  const lines = [`# 历史补录复核清单 ${new Date().toISOString().slice(0, 10)}`, '', `通过 ${accepted.length} / 拒绝 ${rejected.length}`, ''];
  if (rejected.length) {
    lines.push('## 拒绝（未入库）', '');
    for (const x of rejected) lines.push(`- **${x.r.company_cn || '?'} ${x.r.event_date || '?'}** — ${x.why}\n  - ${x.r.url || '无 URL'}\n  - 引句：${String(x.r.evidence_quote || '').slice(0, 80)}`);
    lines.push('');
  }
  const dupe = [];
  for (const db of Object.values(dbs)) {
    const arr = Object.values(db.events).filter(e => e.source_type === 'research');
    for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
      const a = arr[i], b = arr[j];
      if (a.type === b.type && a.company_raw === b.company_raw && a.asset_raw && a.asset_raw === b.asset_raw
        && Math.abs(events.dayNum(a.date) - events.dayNum(b.date)) > 3) dupe.push([a, b]);
    }
  }
  if (dupe.length) {
    lines.push('## 疑似跨月重复（已入库，需人工确认）', '');
    for (const [a, b] of dupe) lines.push(`- ${a.company_raw} ${a.asset_raw} ${a.type}：${a.date} 与 ${b.date}`);
  }
  fs.writeFileSync(outFile, lines.join('\n'));
  console.log(`复核清单：${path.relative(WS, outFile)}`);
})().catch(e => { console.error('❌', e.message); process.exit(1); });

module.exports = { toUsdM };
