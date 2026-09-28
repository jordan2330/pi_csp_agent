/**
 * Excel 导出（通用渲染器，由 scenarios/<name>/scenario.json 驱动）
 *
 * 输出（Sheet 顺序即业务优先级）——**累积视图**：每次都出全量，本次新增高亮：
 *   1. 概览          统计 + 本批次信息 + 图例 + 数据局限说明
 *   2. P1-口服固体     OSD（含改良释放/颗粒散剂），仅时间窗内；按 Cat 1→5 分段，★ 行浅绿底
 *   3. P2-其他剂型     非 OSD，同上
 *   4. 全部商机        累积全量（含已过窗口/已归档的历史行）→ 数据透视 / 图表用
 *   5. 按API汇总       一行 = 一个 API（管理视角）
 *   6. 批次历史        一行 = 一次运行（时间 / 新增 / 累计）→ 看沉淀过程
 *
 * 沉淀口径（scripts/lib/history.js）：
 *   ★ 本次新增 = 相对上一次运行的新增（本批次）   首次发现 = 历史上第一次见到（不随重扫重置）
 *   P1/P2 只放"窗口内"的活跃商机（避免有效期已过的历史行稀释工作清单）；
 *   历史/归档行只在「全部商机」里（窗口状态列标注）。
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { buildLeadModel } = require('./report');
const { isOralSolid } = require('./enrichment');

const WS = path.resolve(__dirname, '..', '..');

// 进行中/可介入的试验状态优先（销售时机信号）
const ACTIVE_STATUS = /进行中|招募|尚未招募|未招募|not yet recruiting|recruiting|active, not recruiting|enrolling/i;

const NEW_ROW_FILL = 'FFE2F0D9';   // 本次新增行：浅绿底
const CAT_COLORS = { 1: 'FFF2CCCC', 2: 'FFFCE4D6', 3: 'FFFFF2CC', 4: 'FFE2EFDA', 5: 'FFF2F2F2' };

const HEADERS = [
  { key: 'star', header: '★ 本次新增', width: 9 },
  { key: 'priority', header: '优先级', width: 12 },
  { key: 'cat', header: '风险等级', width: 16 },
  { key: 'apiCn', header: '主要API(中文)', width: 16 },
  { key: 'apiEn', header: '主要API(英文)', width: 20 },
  { key: 'relatedApis', header: '涉及API(含Cat)', width: 28 },
  { key: 'aiLimit', header: 'AI Limit', width: 12 },
  { key: 'sponsor', header: '申请人/企业', width: 30 },
  { key: 'drugName', header: '产品名称', width: 26 },
  { key: 'dosageForm', header: '剂型', width: 20 },
  { key: 'drugClass', header: '药物分类', width: 14 },
  { key: 'classBasis', header: '分类依据', width: 16 },
  { key: 'regClass', header: '注册分类', width: 10 },
  { key: 'iec', header: '一致性评价', width: 13 },
  { key: 'nmpaSrc', header: '证据来源', width: 20 },
  { key: 'csp', header: '推荐CSP方案', width: 34 },
  { key: 'confirm', header: '待确认', width: 18 },
  { key: 'status', header: '试验状态', width: 16 },
  { key: 'indication', header: '适应症/试验题目', width: 40 },
  { key: 'phase', header: '分期', width: 20 },
  { key: 'regNo', header: '登记号/NCT', width: 14 },
  { key: 'regDate', header: '登记日期', width: 12 },
  { key: 'firstSeen', header: '首次发现', width: 12 },
  { key: 'windowState', header: '窗口状态', width: 10 },
  { key: 'contactName', header: '联系人', width: 10 },
  { key: 'contactPhone', header: '电话', width: 16 },
  { key: 'contactEmail', header: '邮箱', width: 26 },
  { key: 'contactAddress', header: '地址', width: 36 },
  { key: 'source', header: '来源', width: 8 }
];

// ── 把 model 变成"一行 = 一条试验"的扁平记录 ──
// 同一试验（source + 登记号）可能命中多个 API（如复方制剂同时命中两个 API），
// 此处合并为一行，用「涉及API」列标注全部关联 API，风险等级取其中最高（Cat 最小）。
// scope='active' → 只取窗口内活跃商机（P1/P2 用）；scope='all' → 累积全量（全部商机用，含历史行）
function flattenTrials(ctx, scope = 'all') {
  const raw = [];
  let seq = 0;
  const apiEntries = Object.values(ctx.enrichedApis);
  apiEntries.forEach(api => {
    const trials = scope === 'active' ? api.trials : [...api.trials, ...(api.historyTrials || [])];
    trials.forEach(t => {
      seq++;
      raw.push({
        // 无登记号时用自增键，避免被误合并
        key: t.regNo ? `${t.source}|${t.regNo}` : `__no_regno_${seq}`,
        apiCn: api.name_cn || api.name_en,
        apiEn: api.name_en,
        catNum: api.potency_category,
        aiLimit: api.ai_limit,
        csp: api.csp_recommendation || '',
        confirm: api.csp_confirm || '',
        sponsor: t.sponsor || '',
        drugName: t.drugName || '',
        dosageForm: t.dosageForm || '',
        drugClass: t.drugClassification || '未分类',
        classBasis: t.classBasis || '规则推断',
        regClass: (t.nmpa && t.nmpa.regClass) || '',
        iec: (t.nmpa && t.nmpa.iec) || '',
        nmpaSrc: (() => {
          const n = t.nmpa; if (!n) return '';
          const unused = t.classBasis === '规则（证据不适用）';     // 证据存在但未采用（原研企业/代码号）
          const u = n.url || '';
          let base;
          if (n.source === 'cde') base = 'CDE 官方';
          else if (n.source === 'cde+bocha') base = 'CDE 官方 + 博查';
          else if (!u) base = '';
          else { try { base = new URL(u).hostname.replace(/^www\./, ''); } catch (_) { base = u; } }
          return base ? (unused ? `${base}（未采用）` : base) : '';
        })(),
        _basisForCheck: t.classBasis || '规则推断',
        status: t.status || '',
        indication: t.indication || t.briefTitle || '',
        phase: t.phase || '',
        regNo: t.regNo || '',
        regDate: t.regDate || '',
        contactName: t.contactName || '',
        contactPhone: t.contactPhone || '',
        contactEmail: t.contactEmail || '',
        contactAddress: t.contactAddress || '',
        source: t.source || '',
        // ★ 口径：相对上一次运行的新增【且在时间窗内】。
        // 已过窗口/已归档的行不标 ★（P1/P2 有意不放它们，标 ★ 会造成"工作清单外的新增"假象）
        star: (t.isNew && t.inWindow !== false && !t.archived) ? '★' : '',
        _isNewRaw: !!t.isNew,             // 原始新增（不看窗口）→ 概览统计"新增但已过窗口"
        firstSeen: t.first_seen || '',
        windowState: t.archived ? '已归档' : (t.inWindow === false ? '已过窗口' : '窗口内'),
        _sponsorCount: api.sponsorCount,
        _trialCount: api.trialCount,
        _apis: [{ cn: api.name_cn || api.name_en, cat: api.potency_category }]
      });
    });
  });

  // ── 合并同一试验的重复行 ──
  const merged = new Map();
  for (const r of raw) {
    const cur = merged.get(r.key);
    if (!cur) { merged.set(r.key, r); continue; }
    cur._apis.push(...r._apis);
    cur._sponsorCount = Math.max(cur._sponsorCount, r._sponsorCount);
    cur._trialCount = Math.max(cur._trialCount, r._trialCount);
    if (r.drugName.length > cur.drugName.length) cur.drugName = r.drugName;
    if (r.star) cur.star = '★';
    if (r._isNewRaw) cur._isNewRaw = true;
    if (r.firstSeen && (!cur.firstSeen || r.firstSeen < cur.firstSeen)) cur.firstSeen = r.firstSeen;
    if (cur.windowState !== '窗口内' && r.windowState === '窗口内') cur.windowState = '窗口内';
    // 药物分类 / 分类依据 / 注册分类 / 一致性评价 / 证据来源 **必须成套取**：
    // 同一试验命中多个 API 时，各 API 的证据可能不同（有的查到、有的没查到），
    // 逐列独立取会让"分类依据=规则推断"配上"证据来源=CDE 官方"这种自相矛盾组合。
    // 规则：按证据强度挑一条子行，成套搬运这 5 个字段。
    const BASIS_RANK = { '官方证据(CDE)': 0, '搜索证据': 1, '规则（证据不适用）': 2 };
    const rank = (b) => (BASIS_RANK[b] != null ? BASIS_RANK[b] : 3);   // 规则推断/缺省 = 最弱
    if (rank(r.classBasis) < rank(cur.classBasis)) {
      cur.drugClass = r.drugClass; cur.classBasis = r.classBasis;
      cur.regClass = r.regClass; cur.iec = r.iec; cur.nmpaSrc = r.nmpaSrc;
    }
    if (!cur.regClass && r.regClass) cur.regClass = r.regClass;
    if (!cur.iec && r.iec) cur.iec = r.iec;
    // 剂型取能识别到的那个（不同 API 的提取结果可能不同）
    const curOk = cur.dosageForm && cur.dosageForm !== '未识别';
    const rOk = r.dosageForm && r.dosageForm !== '未识别';
    if (!curOk && rOk) cur.dosageForm = r.dosageForm;
    // 取最高风险等级：同时采用该 API 的推荐方案
    if (r.catNum < cur.catNum) {
      Object.assign(cur, { catNum: r.catNum, apiCn: r.apiCn, apiEn: r.apiEn, aiLimit: r.aiLimit, csp: r.csp, confirm: r.confirm });
    }
  }

  const rows = [...merged.values()].map(r => {
    const isOsd = isOralSolid(r.dosageForm);
    const seen = new Set();
    const related = r._apis
      .filter(a => { const k = a.cn; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => a.cat - b.cat || String(a.cn).localeCompare(String(b.cn)))
      .map(a => `${a.cn}(Cat${a.cat})`)
      .join(' / ');
    return {
      ...r,
      osd: isOsd,
      cat: `Cat ${r.catNum}`,
      priority: isOsd ? `P1-OSD-Cat${r.catNum}` : `P2-其他-Cat${r.catNum}`,
      relatedApis: related,
      dosageForm: r.dosageForm || '未识别'
    };
  });

  // ── 不变量自检（列间逻辑一致性）──
  // 目的：新增列时最容易被漏掉的"成套语义"问题，交给机器每次检查，别再靠人眼发现
  const violations = [];
  for (const r of rows) {
    const basis = r.classBasis || '规则推断';
    const src = String(r.nmpaSrc || '');
    if (basis === '规则推断' && src) violations.push([r.key, '规则推断 却有证据来源: ' + src]);
    if (basis === '官方证据(CDE)' && !src.startsWith('CDE 官方')) violations.push([r.key, '官方证据 但来源非 CDE: ' + (src || '(空)')]);
    if (basis === '搜索证据' && !src) violations.push([r.key, '搜索证据 但来源为空']);
    if (basis.startsWith('规则') && src && !src.includes('未采用')) violations.push([r.key, '规则类依据 却显示已采用证据: ' + src]);
  }

  // 排序：OSD 优先 → Cat 升序 → 段内企业数降序 → 进行中优先 → 登记日期降序
  rows.sort((a, b) => {
    if (a.osd !== b.osd) return a.osd ? -1 : 1;
    if (a.catNum !== b.catNum) return a.catNum - b.catNum;
    if (b._sponsorCount !== a._sponsorCount) return b._sponsorCount - a._sponsorCount;
    const aAct = ACTIVE_STATUS.test(a.status) ? 0 : 1;
    const bAct = ACTIVE_STATUS.test(b.status) ? 0 : 1;
    if (aAct !== bAct) return aAct - bAct;
    return String(b.regDate).localeCompare(String(a.regDate));
  });
  if (violations.length) {
    console.error(`⚠️ 分类/证据列一致性自检发现 ${violations.length} 处矛盾（前 5 条）：`);
    violations.slice(0, 5).forEach(([k, msg]) => console.error(`   - ${k}: ${msg}`));
    console.error('   → 请检查 report.js 的 classBasis 判定与 report-xlsx 的合并规则是否同步');
  }
  rows.violations = violations;
  return rows;
}

function styleHeader(ws, cols) {
  ws.columns = cols;
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF44546A' } };
  header.alignment = { vertical: 'middle', horizontal: 'center' };
  header.height = 20;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
}

function writeTrialSheet(wb, name, rows, cols) {
  const ws = wb.addWorksheet(name);
  styleHeader(ws, cols);
  rows.forEach(r => {
    const row = ws.addRow(r);
    const isNew = r.star === '★';
    if (isNew) {
      // 本次新增：整行浅绿底（盖过 Cat 底色——"新增"是更紧迫的信号；下一批次自动恢复常规配色）
      row.eachCell({ includeEmpty: true }, c => {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NEW_ROW_FILL } };
      });
      const star = row.getCell('star');
      star.font = { bold: true, color: { argb: 'FFC00000' } };
      star.alignment = { horizontal: 'center', vertical: 'top' };
    } else {
      row.getCell('cat').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CAT_COLORS[r.catNum] || 'FFFFFFFF' } };
      const star = row.getCell('star');
      star.alignment = { horizontal: 'center', vertical: 'top' };
    }
    if (r.osd) row.getCell('dosageForm').font = { bold: true };
    row.alignment = { vertical: 'top', wrapText: false };
  });
  return ws;
}

function fmtPct(n, d) { return d ? (n / d * 100).toFixed(1) + '%' : '0%'; }

// 最近一次运行批次（来自沉淀账本）
function latestRunLabel() {
  try {
    const runs = require('./history').loadRuns().runs || [];
    const last = runs.slice(-1)[0];
    return last ? `${last.run}（新增 ${last.new} 条 / 当时商机 ${last.total} 条）` : '（尚无批次记录）';
  } catch (_) { return '（尚无批次记录）'; }
}

// ── Sheet 1: 概览 ──
function buildOverviewSheet(wb, ctx, rows, isFull, allRows) {
  const totalRows = allRows || rows;   // 累积全量（含历史沉淀行）
  const ws = wb.addWorksheet('概览');
  ws.columns = [{ width: 34 }, { width: 92 }];
  const title = (t) => { const r = ws.addRow([t, '']); r.font = { bold: true, size: 13 }; };
  const kv = (k, v) => ws.addRow([k, v]);

  const newCount = totalRows.filter(r => r.star === '★').length;
  const newOutWin = totalRows.filter(r => r._isNewRaw && r.windowState !== '窗口内').length;
  const histCount = totalRows.filter(r => r.windowState !== '窗口内').length;
  title(ctx.config.title);
  ws.addRow(['生成日期', ctx.today]);
  ws.addRow(['数据来源', String(ctx.config.source_label).replace('{version}', ctx.snap.fda_data[ctx.config.cache_version_field] || '')]);
  ws.addRow(['交付视图', '累积（全量沉淀 + 本次新增高亮）—— 数据随每次运行累加，不随本次增量删减']);
  const runRow = ws.addRow(['本批次时间', latestRunLabel()]);
  runRow.font = { bold: true };
  const newRow = ws.addRow(['★ 本次新增', `${newCount} 条（浅绿底 + ★ 列，可用首行筛选快速查看）＝ P1 + P2 中的 ★ 行数（去重口径，仅窗口内）`]);
  newRow.getCell(2).font = { bold: true, color: { argb: 'FFC00000' } };
  ws.addRow(['累计商机', `${totalRows.length} 行（本表统计口径 = 窗口内活跃 ${rows.length} 行 + 历史沉淀 ${histCount} 行）`]);
  if (newOutWin) ws.addRow(['新增但已过窗口', `${newOutWin} 条（本批次抓到但登记日期在窗口外，属历史沉淀：不标 ★、只进「全部商机」）`]);
  ws.addRow(['历史沉淀位置', '已过窗口 / 已归档的行只在「全部商机」Sheet（P1/P2 只放窗口内活跃商机，避免稀释工作清单）']);
  ws.addRow([]);

  title('图例（怎么看这张表）');
  kv('★ 本次新增', '相对上一次运行新发现**且在时间窗内**的商机；整行浅绿底，下一批次自动恢复常规配色。已过窗口的新发现不标 ★（历史沉淀行）');
  kv('首次发现', '这条商机历史上第一次被发现的批次日期（不随重扫/缓存重置而改变）');
  kv('窗口状态', `窗口内 = 在 ${ctx.config.lookback_years || 2} 年时间窗内（P1/P2 只放窗口内）；已过窗口 / 已归档 = 历史沉淀行（仅在「全部商机」）`);
  kv('批次历史', '每次运行的 时间 / 新增 / 累计 —— 见「批次历史」Sheet');
  kv('★ 与「首次发现」不一致时', '正常：★ 是"相对上一次运行"的新增（某条商机中途消失又出现也会再标 ★）；首次发现是"历史上第一次见到"，不会被重扫重置');
  ws.addRow([]);

  title('总览');
  kv('FDA 亚硝胺风险 API', ctx.snap.fda_data.total_apis);
  kv('中国有临床试验的 API', ctx.apisWithLeadsCount);
  kv('商机条目（去重后试验数，窗口内）', rows.length);
  kv('按 API 计条目（同一试验命中多个 API 会重复计）', ctx.totalLeads);
  kv('本次新增（按 API 计，复计口径）', ctx.totalNewLeads);
  kv('涉及企业/机构', ctx.allSponsorsGlobalSize);
  kv('数据源', `CDT ${ctx.cdtCount} 条（含联系方式 ${ctx.cdtWithContact}）/ CT.gov ${ctx.ctgovCount} 条（含联系方式 ${ctx.ctgovWithContact}）`);
  ws.addRow([]);

  title('优先级分组（本表 Sheet 顺序即优先级）');
  const p1 = rows.filter(r => r.osd).length;
  const p2 = rows.length - p1;
  kv('P1 口服固体制剂(OSD，含改良释放/颗粒散剂)', `${p1} 条 (${fmtPct(p1, rows.length)})`);
  kv('P2 其他剂型', `${p2} 条 (${fmtPct(p2, rows.length)})`);
  ctx.config.category.order.forEach(c => {
    const n = rows.filter(r => r.catNum === c).length;
    kv(`  └ Cat ${c} ${ctx.config.category.labels[c]}`, `${n} 条`);
  });
  ws.addRow([]);

  title('剂型分布');
  const formCount = {};
  rows.forEach(r => { formCount[r.dosageForm] = (formCount[r.dosageForm] || 0) + 1; });
  Object.entries(formCount).sort((a, b) => b[1] - a[1]).forEach(([f, n]) => kv(f, `${n} 条 (${fmtPct(n, rows.length)})`));
  ws.addRow([]);

  title('药物分类依据（可信度）');
  {
    const basis = {};
    rows.forEach(r => { basis[r.classBasis] = (basis[r.classBasis] || 0) + 1; });
    Object.entries(basis).sort((a, b) => b[1] - a[1]).forEach(([k, v]) =>
      kv(k, `${v} 行 (${fmtPct(v, rows.length)})${k === '官方证据(CDE)' ? ' — 标签与 CDE 官方受理数据一致（可查证）' : k === '搜索证据' ? ' — 标签与博查搜索证据一致' : k === '规则（证据不适用）' ? ' — 该品种有证据但按原研/代码号/改良型排除' : ' — 无可用证据'}`));
    ws.addRow([]);
  }

  title('药物分类分布');
  const classCount = {};
  rows.forEach(r => { classCount[r.drugClass] = (classCount[r.drugClass] || 0) + 1; });
  Object.entries(classCount).sort((a, b) => b[1] - a[1]).forEach(([c, n]) => kv(c, `${n} 条 (${fmtPct(n, rows.length)})`));
  ws.addRow([]);

  // 法规分类证据（Phase 2c：CDE 官方受理数据 为主，博查搜索 为兜底）
  try {
    const nm = require('./nmpa-search');
    const cde = require('./cde-classify');
    const cdeCache = cde.loadCache();
    const cdeAll = Object.values(cdeCache.products || {});
    const cdeSig = cdeAll.filter(e => e.confidence === 'high').length;
    const cdeReg = cdeAll.filter(e => e.confidence === 'high' && (e.facts || {}).regClassDisp).length;
    const bCache = nm.loadCache();
    const bEntries = Object.values(bCache.products || {}).filter(e => e.confidence !== 'none');
    const bCalls = Object.values(bCache.products || {}).reduce((a, e) => a + (e.queries || 0), 0);
    title('法规分类证据（Phase 2c）');
    kv('CDE 官方受理数据（主）', Object.keys(cdeCache.products || {}).length + ' 个品种已查，' + cdeSig + ' 个有分类信号'
      + (cdeReg ? '（其中 ' + cdeReg + ' 个含注册分类）' : ''));
    kv('博查搜索（兜底）', Object.keys(bCache.products || {}).length + ' 个品种已查（累计查询 ' + bCalls + ' 次），' + bEntries.length + ' 个取得证据');
    kv('说明', '空白的注册分类/一致性评价列 = 该品种未取得证据（不等于没有），分类回落规则推断');
    kv('数据源', 'CDE 受理品种信息 = 官方一手申报数据（免费）；博查 = 搜索二手信息，仅用于 CDE 未覆盖的品种');
    ws.addRow([]);
  } catch (_) { /* 未启用搜索富化 */ }

  title('怎么用');
  [
    '1. 销售先看 P1-口服固体：Cat 1 排在最前（AI limit 最严 → 亚硝胺风险最高 → CSP 价值最大）',
    '2. 一行 = 一条试验（已去重）；同一试验涉及多个 API 时看「涉及API」列，风险等级取其中最高',
    '3. 需要 OSD+Cat1 单独视图：在 P1 sheet 用「风险等级」列筛选 = Cat 1 即可',
    '4. 做透视表/图表：用「全部商机」sheet（一行 = 一条试验，字段扁平）',
    '5. 管理视角（每 API 多少家企业/多少条试验）：看「按API汇总」',
    '6. 推荐方案按剂型给出「候选组合」，并标注需向客户确认的信息（如泡罩线 vs 瓶装线）'
  ].forEach(s => kv('', s));
  ws.addRow([]);

  title('数据局限（避免误判）');
  [
    '临床试验登记数据只覆盖研发阶段：企业是否已上市、用什么包装形式（泡罩/瓶装）拿不到，需销售向客户确认',
    'CDT 侧时间窗按登记号年份过滤（粒度=年），报告层再用首次公示日期做精确兜底',
    'CT.gov 的观察性研究（药物仅作背景）无剂型信息，落在「其他剂型」的「未识别」中',
    '药物分类为规则推断（BE→仿制药 / 非原研 I-III 期→新药 / 原研中后期→原研药），仅供筛选参考'
  ].forEach(s => kv('', s));
  ws.getColumn(2).alignment = { wrapText: true, vertical: 'top' };
  return ws;
}

// ── Sheet 5: 按 API 汇总 ──
function buildApiSheet(wb, ctx, isFull) {
  const cols = [
    { key: 'catNum', header: 'Cat', width: 6 },
    { key: 'apiCn', header: 'API(中文)', width: 16 },
    { key: 'apiEn', header: 'API(英文)', width: 22 },
    { key: 'aiLimit', header: 'AI Limit', width: 12 },
    { key: 'dosageGroup', header: '剂型组', width: 14 },
    { key: 'formDist', header: '剂型分布', width: 44 },
    { key: 'trialCount', header: '试验数', width: 8 },
    { key: 'newCount', header: '本次新增', width: 9 },
    { key: 'histCount', header: '历史行数', width: 9 },
    { key: 'sponsorCount', header: '企业数', width: 8 },
    { key: 'oralSolidCount', header: 'OSD条数', width: 9 },
    { key: 'classDist', header: '药物分类分布', width: 32 },
    { key: 'csp', header: '推荐CSP方案', width: 34 },
    { key: 'confirm', header: '待确认', width: 18 }
  ];
  const ws = wb.addWorksheet('按API汇总');
  styleHeader(ws, cols);
  const apis = Object.values(ctx.enrichedApis)
    .filter(a => a.trialCount > 0 || (a.historyTrials || []).length > 0)
    .sort((a, b) => a.potency_category - b.potency_category
      || b.oralSolidCount - a.oralSolidCount
      || b.sponsorCount - a.sponsorCount);
  apis.forEach(a => {
    const formDist = Object.entries(a.groupCounts).map(([g, n]) => `${g}:${n}`).join(' ');
    const classDist = Object.entries(a.classificationCounts).map(([c, n]) => `${c}:${n}`).join(' ');
    const oralNew = a.trials.filter(t => t.isNew && isOralSolid(t.dosageForm)).length;
    const row = ws.addRow({
      catNum: a.potency_category,
      apiCn: a.name_cn || a.name_en,
      apiEn: a.name_en,
      aiLimit: a.ai_limit,
      dosageGroup: a.dosageGroup,
      formDist,
      trialCount: a.trialCount,
      newCount: a.newTrialCount,
      histCount: (a.historyTrials || []).length,
      sponsorCount: a.sponsorCount,
      oralSolidCount: a.oralSolidCount,
      classDist,
      csp: a.csp_recommendation || '',
      confirm: a.csp_confirm || ''
    });
    const hasNew = a.newTrialCount > 0;
    if (hasNew) {
      row.eachCell({ includeEmpty: true }, c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NEW_ROW_FILL } }; });
      const n = row.getCell('newCount');
      n.font = { bold: true, color: { argb: 'FFC00000' } };
    } else {
      row.getCell('catNum').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CAT_COLORS[a.potency_category] || 'FFFFFFFF' } };
    }
    if (row.getCell('oralSolidCount').value > 0) row.getCell('oralSolidCount').font = { bold: true };
  });
  return ws;
}

// ── 主入口 ──
// 累积视图：每次都出全量 + 本次新增高亮（★ + 浅绿底）；P1/P2 仅窗口内活跃商机
// runMeta = { run, date, new_records }（来自 pipeline）；★ 口径由渲染器统一计算并写入批次档案，
// 保证「批次历史的 本次新增」=「表里的 ★ 行数」——**单一权威，避免两处实现漂移**
function generateWorkbook(snapshot, scenario, isFull, runMeta = {}) {
  const ctx = buildLeadModel(snapshot, scenario, isFull);
  const activeRows = flattenTrials(ctx, 'active');    // 窗口内 → P1/P2
  const allRows = flattenTrials(ctx, 'all');          // 累积全量 → 全部商机
  const newRows = allRows.filter(r => r.star === '★').length;
  const newOutWin = allRows.filter(r => r._isNewRaw && r.windowState !== '窗口内').length;

  // 批次档案（★ 口径；记录级新增由 pipeline 传入）
  try {
    const hist = require('./history');
    const srcCount = {};
    Object.values(ctx.enrichedApis).forEach(a => [...a.trials, ...(a.historyTrials || [])]
      .forEach(t => { srcCount[t.source] = (srcCount[t.source] || 0) + 1; }));
    let cdeStat = { total: 0, signals: 0 };
    try {
      const cdeProducts = Object.values(require('./cde-classify').loadCache().products || {});
      cdeStat = { total: cdeProducts.length, signals: cdeProducts.filter(e => e.confidence === 'high').length };
    } catch (_) {}
    hist.appendRun({
      run: runMeta.run || `${ctx.today} (重建)`, date: runMeta.date || ctx.today,
      new: newRows, new_records: runMeta.new_records != null ? runMeta.new_records : newRows,
      total: allRows.length, total_active: activeRows.length,
      archived: allRows.filter(r => r.windowState === '已归档').length,
      sources: srcCount, enrich: { cde_products: cdeStat.total, cde_signals: cdeStat.signals }
    });
  } catch (_) { /* runs.json 不可写时不影响交付物 */ }

  // 结构性断言：活跃行必须完全等于 P1+P2，且不得混入历史行
  const osdRows = activeRows.filter(r => r.osd), otherRows = activeRows.filter(r => !r.osd);
  if (osdRows.length + otherRows.length !== activeRows.length) {
    console.error('⚠️ 自检: P1+P2 行数与活跃行数不符');
  }
  const leaked = activeRows.filter(r => r.windowState !== '窗口内');
  if (leaked.length) console.error(`⚠️ 自检: ${leaked.length} 条历史行混进了 P1/P2`);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'pi_csp_agent';
  wb.created = new Date();

  buildOverviewSheet(wb, ctx, activeRows, isFull, allRows);
  writeTrialSheet(wb, 'P1-口服固体', osdRows, HEADERS);
  writeTrialSheet(wb, 'P2-其他剂型', otherRows, HEADERS);
  writeTrialSheet(wb, '全部商机', allRows, HEADERS);
  buildApiSheet(wb, ctx, isFull);
  buildBatchSheet(wb);

  const xlsxPath = path.join(WS, ctx.config.report_xlsx || 'output/CSP_Leads_Report.xlsx');

  fs.mkdirSync(path.dirname(xlsxPath), { recursive: true });
  return wb.xlsx.writeFile(xlsxPath).then(() => ({
    xlsxPath,
    rows: allRows.length,
    activeRows: activeRows.length,
    p1: osdRows.length,
    p2: otherRows.length,
    newRows,
    newOutWin,
    violations: (allRows.violations || []).length
  }));
}

// ── Sheet 6: 批次历史（每次运行的沉淀过程）──
function buildBatchSheet(wb) {
  const cols = [
    { key: 'run', header: '运行批次（本地时间）', width: 22 },
    { key: 'date', header: '日期', width: 12 },
    { key: 'new', header: '★ 新增(窗口内)', width: 12 },
    { key: 'newRecords', header: '抓取新增(全部)', width: 12 },
    { key: 'total', header: '累计商机行(全部)', width: 13 },
    { key: 'totalActive', header: '窗口内活跃', width: 11 },
    { key: 'cumulative', header: '账本累计', width: 10 },
    { key: 'archived', header: '归档行', width: 9 },
    { key: 'ctgov', header: 'CT.gov 条', width: 10 },
    { key: 'cdt', header: 'CDT 条', width: 9 },
    { key: 'cdeProducts', header: 'CDE已查品种', width: 11 },
    { key: 'cdeSignals', header: 'CDE有分类信号', width: 12 }
  ];
  const ws = wb.addWorksheet('批次历史');
  styleHeader(ws, cols);
  let runs = [];
  try { runs = require('./history').loadRuns().runs || []; } catch (_) {}
  // 账本累计：用历史账本按 first_seen 统计（比 runs 记录更可靠）
  let ledgerByBatch = {};
  try {
    Object.values(require('./history').loadLedger().entries || {}).forEach(e => {
      ledgerByBatch[e.first_seen] = (ledgerByBatch[e.first_seen] || 0) + 1;
    });
  } catch (_) {}
  let cumulative = 0;
  runs.slice(-100).forEach(r => {
    const e = r.enrich || {};
    const row = ws.addRow({
      run: r.run, date: r.date, new: r.new, newRecords: r.new_records != null ? r.new_records : r.new,
      total: r.total, totalActive: r.total_active != null ? r.total_active : '', cumulative: '',
      archived: r.archived || 0,
      ctgov: (r.sources || {})['CT.gov'] || 0,
      cdt: (r.sources || {})['CDT'] || 0,
      cdeProducts: e.cde_products || 0,
      cdeSignals: e.cde_signals || 0
    });
    if ((r.new || 0) > 0) {
      const n = row.getCell('new');
      n.font = { bold: true, color: { argb: 'FFC00000' } };
    }
  });
  // 账本批次汇总（无 runs 记录时的兜底视图）
  const batches = Object.entries(ledgerByBatch).sort();
  if (batches.length) {
    ws.addRow([]);
    const t = ws.addRow(['沉淀账本按首次发现批次统计', '', '', '', '', '', '', '', '', '']);
    t.font = { bold: true };
    Object.entries(ledgerByBatch).sort().forEach(([d, n]) => {
      cumulative += n;
      ws.addRow([d, d, n, '', cumulative, '', '', '', '', '']);
    });
  }
  return ws;
}

module.exports = { generateWorkbook, flattenTrials };