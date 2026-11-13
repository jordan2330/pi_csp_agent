#!/usr/bin/env node
/**
 * 管线场景 —— 用 CDT（药物临床试验登记与信息公示平台）给「纯中文名资产」补期次（D3）
 *
 * 为什么需要它：CT.gov 只索引英文名，纯中文药名（格隆溴铵注射液、泽普昔替尼胶囊…）在那边 0 命中；
 * CDT 按药物名称精确匹配（drugs_name + drugs_type=2），是这批资产唯一的期次来源。
 *
 * 保守原则（宁可空着，不可错挂）：
 *   ① 必须过药物名匹配（CDT 详情里的 drugName 与本地药名核心词互相包含）；
 *   ② 申请人也要对上（归一后互含）；对不上时，只有当"命中的试验只来自同一个申请人"才接受，
 *      并记成 `CDT(药名唯一申请人)` 以便审计；
 *   ③ BE/生物等效性试验不算期次（不给 D3 分）。
 *
 * 用法：
 *   node scenarios/pipeline/enrich-phase-cdt.js --limit 5 --dry-run   # 试跑，不写盘
 *   node scenarios/pipeline/enrich-phase-cdt.js --limit 30            # 分批
 *   node scenarios/pipeline/enrich-phase-cdt.js                       # 全部
 */

const fs = require('fs');
const path = require('path');

const WS = path.resolve(__dirname, '..', '..');
const FILE = path.join(WS, 'output', 'history', 'pipeline-cde.json');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d; };
const LIMIT = arg('--limit', 1e9);
const MAX_DETAILS = arg('--max-details', 8);
const DRY = process.argv.includes('--dry-run');
const RECHECK = process.argv.includes('--recheck');
const log = (...a) => console.log(...a);

// 剂型后缀：去掉后才是 CDT 里的药物名（CDT 的药物名称通常不含剂型）
// 代号（HRS-7058 / LNK01001 / TQH3906）：CT.gov 与 CDT 都按代号索引，CDT 常能补上 CT.gov 没收录的中国试验
const CODE = /[A-Za-z]{1,7}[-‐]?\d{2,8}[A-Za-z]{0,4}/;
const FORM_TAIL = /(注射用|冻干粉针剂|冻干粉针|干混悬剂|混悬液|口服溶液|口服液|软胶囊|缓释胶囊|缓释片|控释片|肠溶片|肠溶胶囊|分散片|咀嚼片|泡腾片|滴丸|滴眼液|眼用凝胶|气雾剂|喷雾剂|吸入粉雾剂|吸入剂|注射液|注射剂|凝胶剂|乳膏|软膏|贴剂|栓剂|颗粒|胶囊|片剂|糖浆|合剂|散剂|散|凝胶|乳|滴剂|搽剂|酊|贴|膜)$/;
const coreName = (drugName) => {
  let s = String(drugName || '').replace(/\s+/g, '');
  for (let i = 0; i < 3 && FORM_TAIL.test(s); i++) s = s.replace(FORM_TAIL, '');   // 复方双后缀：注射液+注射用
  return s.replace(/^(复方|注射用)/, (m) => (m === '复方' ? '复方' : ''));
};

// CDT 期次文本 → rank（与 enrich-phase.js 同口径：III=3 / II=2 / I=1；BE/其他=0）
const rankOf = (phaseText) => {
  const p = String(phaseText || '');
  if (/^(?:IV|Ⅳ|4)/.test(p)) return 0;   // IV期=上市后研究，与 CT.gov 的 PHASE4 同口径记 0
  if (/(?:III|Ⅲ|III期)/.test(p) || /^3/.test(p)) return 3;
  if (/(?:II|Ⅱ)/.test(p) || /^2/.test(p)) return 2;
  if (/(?:I|Ⅰ)/.test(p) || /^1/.test(p)) return 1;
  return 0;   // 生物等效性 / 其他 / 空
};
const phaseLabel = (r) => (r === 3 ? 'III期' : r === 2 ? 'II期' : r === 1 ? 'I期' : '');

// 公司名归一一律复用 scope.js（避免第三套语义分叉：曾因括号规则不一致误并）
const { normalize: scopeNormalize, stripRemarkParen } = require('./scope');
const strip = (s) => scopeNormalize(stripRemarkParen(s));
const overlap = (a, b) => {
  const x = strip(a), y = strip(b);
  if (!x || !y) return false;
  return x === y || (x.length >= 4 && y.includes(x)) || (y.length >= 4 && x.includes(y));
};

(async () => {
  let store;
  try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {
    console.error(`❌ 无法读取 ${path.relative(WS, FILE)}: ${e.message}（先跑 sources-cde.js）`); process.exit(1);
  }
  // 优先级：分数高的先查（越接近 A/B 档阈值的行，期次补上越可能改档）
  const scoring = require('./scoring');
  const pts = (r) => scoring.score({ drugName: r.drugName, company: r.company, regClass: r.regClass, phase: r.phase || '', regNo: r.regNo, d7: r.d7 }, { mode: 'full' }).points;
  const targets = Object.entries(store.rows || {})
    .filter(([, r]) => RECHECK || !(r.phase && r.phase_src))
    .filter(([, r]) => RECHECK || !r.cdt_checked_at)          // 已查过不再重复（CDT 有瑞数风控，每日跑要控量）
    .map(([k, r]) => [k, r, pts(r)])
    .sort((a, b) => b[2] - a[2])                                  // 同分组内高分优先
    .slice(0, LIMIT);
  if (!targets.length) { log('没有需要补期次的资产'); return; }
  log(`待查资产 ${targets.length} 个（无期次；按当前分降序，可随时中断重跑）`);

  const C = require(path.join(WS, 'skills', 'browser_executor', 'scripts', 'cdt-search-lib.js'));
  const browser = await C.connectBrowser();
  log(`CDT 会话就绪（真浏览器=${C.isRealBrowser ? C.isRealBrowser() : '?'}）`);

  let done = 0, hit = 0, errs = 0, skipped = 0;
  const dist = {};
  for (const [k, r] of targets) {
    const code = (String(r.drugName).match(CODE) || [])[0];
    const core = code || coreName(r.drugName);
    const row = store.rows[k];
    done++;
    if (core.length < 3) { skipped++; continue; }
    try {
      // 站点偶发返回空（瑞数风控限流）→ 换全名重试一次，仍是 0 才判定无命中
      const query = async (q) => C.searchOneAPI(browser, q, { maxPages: 1, maxDetails: MAX_DETAILS, logPrefix: '[CDT]' });
      let res = await query(core);
      if (!res.totalResults && r.drugName.replace(/\s+/g, '') !== core) {
        await new Promise(s => setTimeout(s, 2000));
        res = await query(r.drugName.replace(/\s+/g, ''));
      }
      const trials = (res.detailedTrials || []).filter(t => t && t.trialPhase);
      // ① 药物名匹配
      const byName = trials.filter(t => overlap(t.drugName || t.searchDrugName, r.drugName) || overlap(t.drugName || t.searchDrugName, core));
      // ② 申请人匹配（本地公司 或 company_raw 里任一别名）
      const companies = [r.company, ...(r.company_raw || [])];
      const matched = byName.filter(t => companies.some(c => overlap(t.applicantName, c)));
      const pool = matched.length ? matched : null;
      const applicants = [...new Set(byName.map(t => strip(t.applicantName)).filter(Boolean))];
      const useNameOnly = !pool && byName.length && applicants.length === 1;   // 唯一申请人 → 可接受但标注
      const chosen = pool || (useNameOnly ? byName : []);
      const best = chosen.reduce((m, t) => Math.max(m, rankOf(t.trialPhase)), 0);
      const kind = code ? '代号' : '药名';
      const src = best === 0 ? '' : pool ? `CDT(${kind}+申请人)` : `CDT(${kind}唯一申请人)`;
      if (best > 0) hit++;
      let why = phaseLabel(best) + ' ' + src;
      if (best === 0) {
        if (!res.totalResults) why = '无命中';
        else if (!trials.length) why = `有 ${res.totalResults} 条试验，但没登记期次`;
        else if (!byName.length) why = `有 ${res.totalResults} 条试验，但药名对不上`;
        else why = `有 ${res.totalResults} 条试验，但申请人不同`;
      }
      log(`  ${best ? '✓' : '·'} ${r.drugName.slice(0, 16).padEnd(17)} ${r.company.slice(0, 18).padEnd(20)} → ${why}`);
      if (!DRY) {
        if (best === 0 && row.phase && row.phase_src) {           // 重查无命中 → 保留原值，别用空覆盖
          row.cdt_checked_at = new Date().toISOString().slice(0, 10);
          dist[best] = (dist[best] || 0) + 1;
          continue;
        }
        row.cdt_checked_at = new Date().toISOString().slice(0, 10);
        row.phase = best ? phaseLabel(best) : '';
        row.phase_rank = best;
        row.phase_src = src;
        row.nct = '';
        row.cdt_regno = chosen.length ? (chosen[0].regNo || '') : '';
        row.cdt_applicant = chosen.length ? (chosen[0].applicantName || '') : '';
      }
      dist[best] = (dist[best] || 0) + 1;
      if (done % 10 === 0) { log(`  …${done}/${targets.length}  命中 ${hit}  错误 ${errs}`); if (!DRY) save(store); }
    } catch (e) {
      errs++;
      console.error(`  ⚠️ ${r.drugName}: ${e.message.slice(0, 80)}`);
    }
    await new Promise(s => setTimeout(s, 800));   // 站点有瑞数风控：串行 + 间隔
  }
  if (!DRY) save(store);
  log(`\n完成：${done} 个（跳过 ${skipped}），命中期次 ${hit}，错误 ${errs}，rank 分布 ${JSON.stringify(dist)}`);
  if (!DRY) log(`已写入 ${path.relative(WS, FILE)}`);

  // 自检：写了期次的行必须有来源；rank 与标签必须一致
  const bad = Object.entries(store.rows).filter(([, x]) => (x.phase && !x.phase_src) || (x.phase && phaseLabel(x.phase_rank) !== x.phase));
  if (bad.length) console.error(`❌ 自检失败：${bad.length} 行期次无来源或标签不一致，例 ${bad[0][0]}`);
  else log('✅ 自检通过：有期次的行都有来源，标签与 rank 一致');
})().catch(e => { console.error('❌', e.message); process.exit(1); });

function save(store) {
  store.phase_updated_at = new Date().toISOString();
  fs.writeFileSync(FILE, JSON.stringify(store, null, 1));
}