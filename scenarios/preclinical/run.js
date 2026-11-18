#!/usr/bin/env node
/**
 * 临床前管线信号 —— 每日抓取 + 抽取 + 入账本（Phase 0 用 --report 出人工复核表）
 *
 * 用法：
 *   node scenarios/preclinical/run.js --limit 50 --dry --report output/preclinical/review.md   # Phase 0：只看不写
 *   node scenarios/preclinical/run.js --no-llm                # 只跑抓取+关键词过滤（不需要 Key，验证源）
 *   node scenarios/preclinical/run.js --since-hours 30         # 日常：只看最近 30 小时
 *
 * 失败降级：单个源挂 → 跳过并告警；LLM 失败 → 该条进 needs_review，绝不静默丢弃。
 */

const fs = require('fs');
const path = require('path');
const cfg = require('./config.json');
const { fetchWechat, fetchGoogleNews } = require('./lib/rss');
const { fetchCninfo } = require('./lib/cninfo');
const { pdfText } = require('./lib/pdf');
const { candidates } = require('./lib/filter');
const { extractOne } = require('./lib/extract');
const events = require('./lib/events');
const aliases = require('./lib/aliases');

const WS = path.resolve(__dirname, '..', '..');
require(path.join(WS, 'scripts', 'lib', 'wecom.js')).loadEnv();   // 复用零依赖 .env 解析（DASHSCOPE_API_KEY）
const arg = (n, d) => { const i = process.argv.indexOf(n); return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d; };
const has = (f) => process.argv.includes(f);
const LIMIT = arg('--limit', 50);
const SINCE_H = arg('--since-hours', 24 * 7);
const MIN_SCORE = arg('--min-score', 4);
const DRY = has('--dry');
const NO_LLM = has('--no-llm');
const REPORT = (() => { const i = process.argv.indexOf('--report'); return i !== -1 ? process.argv[i + 1] : null; })();
const ONLY = (() => { const i = process.argv.indexOf('--source'); return i !== -1 ? process.argv[i + 1] : null; })();
const log = (...a) => console.log(...a);

(async () => {
  log(`═══ 抓取（${Object.keys(cfg.feeds).length} 个公众号 + ${cfg.google_news.length} 组 Google News + ${(cfg.cninfo_queries || []).length} 组 cninfo） ═══`);
  const items = [
    ...await fetchWechat(cfg, log),
    ...await fetchCninfo(cfg, { hours: SINCE_H, log }),
    ...await fetchGoogleNews(cfg, log)
  ];
  const since = Date.now() - SINCE_H * 3600e3;
  const fresh = items.filter(it => !it.published || Date.parse(it.published) >= since);
  log(`\n共 ${items.length} 条，${SINCE_H}h 内 ${fresh.length} 条`);

  const pool = ONLY ? fresh.filter(it => it.source.includes(ONLY)) : fresh;
  const cands = candidates(pool, cfg.keywords, { minScore: MIN_SCORE }).slice(0, LIMIT);
  log(`关键词过闸 ${cands.length} 条（阈值 ${MIN_SCORE}，上限 ${LIMIT}）`);
  if (NO_LLM) {
    for (const c of cands) log(`  ${String(c.score).padStart(3)} [${c.source}] ${c.title.slice(0, 50)}  命中:${c.hits.slice(0, 4).join('/')}`);
    return;
  }

  log('\n═══ 抽取（' + cfg.llm.model + '） ═══');
  const year = new Date().getFullYear();
  const db = events.load(year);
  const results = [];
  let next = 0, ok = 0, failed = 0, added = 0, merged = 0;
  async function worker() {
    while (next < cands.length) {
      const it = cands[next++];
      try {
        // cninfo 只有标题 + PDF 直链 → 抽正文（金额/授权范围只在 PDF 里）
        if (it.titleOnly && /\.PDF$/i.test(it.url || '') && it.text.length < 200) {
          try { it.text = await pdfText(it.url, { maxPages: 6 }); } catch (e) { log(`    PDF 失败(${e.message.slice(0, 30)})，退回标题`); }
        }
        if (it.text) aliases.learn(`${it.title} ${it.text}`);      // 学「IBI324（OLN324）」这类改名配对
        const ev = await extractOne(it, cfg, { log });
        ev.company_raw = ev.company_cn || '';                 // 行主角 = 中国公司（MNC 只做 counterparty）
        ev.type = ev.company_cn ? ev.type : 'other';
        ev.date = String(ev.event_date || (it.published || '').slice(0, 10) || '').slice(0, 10);
        if (ev.ok) {
          ok++;
          if (!DRY) {
            const r = events.upsert(db, ev);
            if (r.action === 'added') added++; else merged++;
          }
        } else failed++;
        results.push({ item: it, ev });
        log(`  ${ev.ok ? '✓' : '·'} [${it.source}] ${it.title.slice(0, 40)} ${ev.ok ? '→ ' + ev.type + ' ' + (ev.company_raw || '') : '(' + (ev.review_why || '跳过') + ')'}`);
      } catch (e) {
        failed++;
        results.push({ item: it, ev: { ok: false, needs_review: true, review_why: e.message.slice(0, 60) } });
        log(`  ⚠️ [${it.source}] ${it.title.slice(0, 36)} — ${e.message.slice(0, 60)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(cfg.llm.concurrency || 3, cands.length) }, () => worker()));

  if (!DRY) events.save(year, db);
  log(`\n抽取完成：有效 ${ok} / 复核 ${failed} | 账本新增 ${added} 合并 ${merged}${DRY ? '（--dry 未落盘）' : ''}`);

  if (REPORT) {
    const out = path.resolve(WS, REPORT);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, renderReport(results, { SINCE_H, MIN_SCORE }));
    log(`复核表已写入 ${path.relative(WS, out)}`);
  }
})().catch(e => { console.error('❌', e.message); process.exit(1); });

function renderReport(results, meta) {
  const rows = results.map(({ item, ev }, i) => {
    const f = (k) => (ev[k] ? String(ev[k]).replace(/\|/g, '/').slice(0, 60) : '');
    return [
      i + 1,
      ev.ok ? '✅' : (ev.review_why === '非事件' ? '·' : '⚠️'),
      `[${item.source}] ${item.title.slice(0, 46).replace(/\|/g, '/')}`,
      f('type'), f('company_cn'), f('counterparty_raw'), f('asset_raw'), f('phase_raw'),
      [f('amount_upfront_raw'), f('amount_total_raw')].filter(Boolean).join(' / '),
      f('territory_raw'), f('evidence_quote'), ev.review_why || ''
    ].join(' | ');
  });
  const okN = results.filter(r => r.ev.ok).length;
  return [
    `# 临床前信号抽取复核（${new Date().toISOString().slice(0, 16)}）`,
    '',
    `窗口 ${meta.SINCE_H}h | 关键词阈值 ${meta.MIN_SCORE} | 共 ${results.length} 条 | 有效 ${okN} | 精确率 ${(100 * okN / Math.max(1, results.length)).toFixed(0)}%`,
    '',
    '判定标准：✅=是真事件且引文能回文；⚠️=模型说是事件但引文对不上（疑似幻觉）；·=模型判为非事件',
    '',
    '| # | 判 | 标题 | 类型 | 中国公司 | 对方 | 资产 | 阶段 | 金额 | 授权范围 | 引文 | 说明 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows
  ].join('\n');
}