#!/usr/bin/env node
/**
 * CDE 受理品种信息 —— 管线场景种子采集器
 *
 * 为什么用这个源：CDE 受理（承办日期）是中国境内「企业已立项并递交」的最早公共证据（T0），
 *   且自带 受理号/药品名/药品类型/申请类型/注册分类/企业名/日期 七个结构化字段。
 * 为什么不用筛选控件：页面的 year/applytype 下拉走 Vue 绑定，set value + change 不生效
 *   （实测总数纹丝不动）→ 改用「列表天然按承办日期倒序 + 日期游标翻页」，本地过滤。
 * 为什么不用 CT.gov 反查：CT.gov 只索引英文申办方名（中文名实测 0 命中）。
 *
 * 用法：
 *   node scenarios/pipeline/sources-cde.js                  # 增量（翻到早于游标即停）
 *   node scenarios/pipeline/sources-cde.js --lookback-days 730   # 首跑回填 2 年
 *   node scenarios/pipeline/sources-cde.js --max-pages 5 --no-save   # 只探几页
 *
 * 产物（均 gitignore）：
 *   config/pipeline-cursor.json           { cde: { last_date, updated_at } }
 *   output/history/pipeline-cde.json      公司×资产候选行（含 first_seen/last_seen）
 */

const fs = require('fs');
const path = require('path');
const C = require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'cde-classify'));
const scoring = require('./scoring');
const scope = require('./scope');

const WS = path.resolve(__dirname, '..', '..');
const CURSOR_FILE = path.join(WS, 'config', 'pipeline-cursor.json');
const OUT_FILE = path.join(WS, 'output', 'history', 'pipeline-cde.json');
const PAGE_SIZE = 50;
const arg = (n, d) => { const i = process.argv.indexOf(n); return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d; };
const MAX_PAGES = arg('--max-pages', 200);
const START_PAGE = arg('--start-page', 1);      // 续回填：直接从第 N 页开始，不必重扫前面
const LOOKBACK_DAYS = arg('--lookback-days', 365);
const NO_SAVE = process.argv.includes('--no-save');
const FROM = (() => { const i = process.argv.indexOf('--from'); return i !== -1 ? process.argv[i + 1] : null; })();   // 显式起点：继续回填历史用
const TODAY = new Date().toISOString().slice(0, 10);
const CUTOFF = new Date(Date.now() - LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10);
const log = (...a) => console.log(...a);

// 口径统一在 scope.js（化药 + 1/2.x 类 + 新药|进口；中药/补充申请不进池）

// ── 翻页（layui）──
async function nextPage(page) {
  return page.evaluate(() => {
    const el = [...document.querySelectorAll('.layui-laypage-next, button, a, li')]
      .find(e => /下一页/.test(e.innerText || ''));
    if (!el) return 'no-next';
    if (/disabled/.test(el.className || '')) return 'disabled';
    el.click();
    return 'clicked';
  });
}

(async () => {
  const cursor = (() => { try { return JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf8')); } catch { return {}; } })();
  const prev = cursor.cde || {};
  const stopAt = FROM || prev.last_date || CUTOFF;
  log(`停止边界: ${stopAt}${FROM ? ' (--from)' : prev.last_date ? ' (游标)' : ' (回填窗口)'} | 最多 ${MAX_PAGES} 页`);

  const { page } = await C.connectBrowser();
  await C.openForm(page);
  await C.setPageSize(page, PAGE_SIZE);
  await page.waitForTimeout(2000);
  if (START_PAGE > 1) {
    const jumped = await page.evaluate((n) => {
      const inp = document.querySelector('.layui-laypage-skip input');
      const btn = document.querySelector('.layui-laypage-skip button');
      if (!inp || !btn) return 'no-skip';
      inp.value = String(n); inp.dispatchEvent(new Event('input', { bubbles: true })); btn.click(); return 'ok';
    }, START_PAGE);
    log(`跳到第 ${START_PAGE} 页: ${jumped}`);
    if (jumped !== 'ok') process.exit(1);
    await page.waitForTimeout(3000);
  }

  const picked = new Map();     // key → row
  let scanned = 0, pages = 0, firstMaxDate = null, lastPageMax = null, stopReason = '';
  for (let i = 0; i < MAX_PAGES; i++) {
    const r = await C.parseTableWithTotal(page);
    const rows = (r.rows || []).filter(x => x.date && /^\d{4}-\d{2}-\d{2}$/.test(x.date));
    if (!rows.length) { stopReason = '无有效行（页面结构可能改版）'; break; }
    pages++; scanned += rows.length;
    const pageMax = rows[0].date;                       // 列表倒序 → 首行最新
    if (i === 0) firstMaxDate = pageMax;
    // 自检：翻页后最新日期不得变大（否则不是倒序 → 游标会失效）
    if (lastPageMax && pageMax > lastPageMax) { console.error(`❌ 翻页后日期变大（${lastPageMax} → ${pageMax}），列表不再是倒序，已有游标不可信`); process.exit(1); }
    lastPageMax = pageMax;

    for (const x of rows) {
      if (x.date < stopAt) { stopReason = `到达游标/回填边界（${x.date} < ${stopAt}）`; break; }
      if (!scope.inScope(x)) continue;
      for (const co of String(x.company || '').split(/[;；]/).map(s => s.trim())
        .filter(co => co.length >= 2 && !/^(无|不适用|N\/A|-|\/)$/i.test(co))) {
        const key = `${scope.companyKey(co)}|${scope.normalize(x.drugName)}`;
        const old = picked.get(key);
        if (!old || x.date > old.lastSeen) picked.set(key, { ...x, company: co, firstSeen: old ? old.firstSeen : x.date, lastSeen: x.date });
      }
    }
    if (stopReason) break;
    if (i % 10 === 9) log(`  …第 ${pages} 页，扫描 ${scanned} 行，候选 ${picked.size}`);
    const nav = await nextPage(page);
    if (nav !== 'clicked') { stopReason = `翻页结束（${nav}）`; break; }
    await page.waitForTimeout(2500);
  }
  log(`翻页 ${pages} 页 | 扫描 ${scanned} 行 | 候选（公司×资产）${picked.size} | 停止原因: ${stopReason}`);

  // ── 自检：首页最新日期必须 ≥ 游标（否则说明游标比页面还新，可能是页面回滚/改版）──
  if (START_PAGE === 1 && prev.last_date && firstMaxDate && firstMaxDate < prev.last_date) {
    console.error(`❌ 首页最新受理日 ${firstMaxDate} 早于游标 ${prev.last_date} —— 列表未更新或页面改版，拒绝推进游标`);
    process.exit(1);
  }

  // ── 分布 + 打分预览 ──
  const rows = [...picked.values()];
  const dist = (f) => rows.reduce((m, r) => (m[f(r)] = (m[f(r)] || 0) + 1, m), {});
  log('药品类型:', JSON.stringify(dist(r => r.drugType)));
  log('注册分类:', JSON.stringify(dist(r => r.regClass || '?')));
  log('申请类型:', JSON.stringify(dist(r => r.applyType || '?')));
  const scored = rows.map(r => {
    const s = scoring.score({ drugName: r.drugName, apiName: '', regClass: r.regClass, onNitrosamineList: false, phase: '' });
    return { ...r, ...s };
  });
  const tier = scored.reduce((m, r) => (m[r.tier] = (m[r.tier] || 0) + 1, m), {});
  log('档位(lite, 无期次):', JSON.stringify(tier), '| 出局:', scored.filter(r => r.excluded).length);
  const top = scored.filter(r => !r.excluded).sort((a, b) => b.points - a.points).slice(0, 10);
  log('\n高分预览（无期次时上限 12）:');
  top.forEach(r => log(` ${r.points} ${r.drugName.slice(0, 22).padEnd(24)} ${r.company.slice(0, 26).padEnd(28)} ${r.regClass} ${r.date}`));

  if (NO_SAVE) { log('\n(--no-save，未写入任何文件)'); process.exit(0); }

  // ── 合并落盘 ──
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  const store = (() => { try { return JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); } catch { return { rows: {} }; } })();
  store.rows = store.rows || {};
  for (const r of rows) {
    const k = `${r.company}|${r.drugName}`;
    // 只覆盖 CDE 来源列；富化字段（期次/联系渠道/受理号集合/公司原值）必须保留，否则每轮重采都会清空
    const old = store.rows[k] || {};
    store.rows[k] = {
      ...old, ...r,
      first_seen: old.first_seen || r.firstSeen, last_seen: r.lastSeen,
      phase: old.phase || '', phase_rank: old.phase_rank || 0, phase_src: old.phase_src || '',
      nct: old.nct || '', d7: old.d7 || null,
      reg_nos: old.reg_nos || [], company_raw: old.company_raw || [],
      cdt_regno: old.cdt_regno || '', cdt_applicant: old.cdt_applicant || '', cdt_checked_at: old.cdt_checked_at || ''
    };
  }
  store.updated_at = TODAY;
  fs.writeFileSync(OUT_FILE, JSON.stringify(store, null, 1));

  const maxDate = rows.reduce((m, r) => (r.date > m ? r.date : m), prev.last_date || '');
  fs.writeFileSync(CURSOR_FILE, JSON.stringify({ ...cursor, cde: { last_date: maxDate, updated_at: new Date().toISOString() } }, null, 1));
  log(`\n✅ 已写入 ${path.relative(WS, OUT_FILE)}（累计 ${Object.keys(store.rows).length} 行）| 游标推进到 ${maxDate}`);
})().catch(e => { console.error('❌', e.message); process.exit(1); });