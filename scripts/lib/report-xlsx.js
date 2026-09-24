/**
 * Excel 导出（通用渲染器，由 scenarios/<name>/scenario.json 驱动）
 *
 * 输出（Sheet 顺序即业务优先级）：
 *   1. 概览          统计 + 用法 + 数据局限说明
 *   2. P1-口服固体     OSD（含改良释放/颗粒散剂），按 AI limit Cat 1→5 分段，段内按企业数排序
 *   3. P2-其他剂型     非 OSD，同样按 Cat 1→5 分段
 *   4. 全部商机        扁平表（一行 = 一条试验）→ 数据透视 / 图表用
 *   5. 按API汇总       一行 = 一个 API（管理视角）
 *
 * 说明：OSD+Cat1 等组合视图不需要单独 sheet——用 Excel 自动筛选（首行已开启）即可秒出。
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { buildLeadModel } = require('./report');
const { isOralSolid } = require('./enrichment');

const WS = path.resolve(__dirname, '..', '..');

// 进行中/可介入的试验状态优先（销售时机信号）
const ACTIVE_STATUS = /进行中|招募|尚未招募|未招募|not yet recruiting|recruiting|active, not recruiting|enrolling/i;

const CAT_COLORS = { 1: 'FFF2CCCC', 2: 'FFFCE4D6', 3: 'FFFFF2CC', 4: 'FFE2EFDA', 5: 'FFF2F2F2' };

const HEADERS = [
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
  { key: 'contactName', header: '联系人', width: 10 },
  { key: 'contactPhone', header: '电话', width: 16 },
  { key: 'contactEmail', header: '邮箱', width: 26 },
  { key: 'contactAddress', header: '地址', width: 36 },
  { key: 'source', header: '来源', width: 8 },
  { key: 'isNew', header: '本次新增', width: 10 }
];

// ── 把 model 变成"一行 = 一条试验"的扁平记录 ──
// 同一试验（source + 登记号）可能命中多个 API（如复方制剂同时命中两个 API），
// 此处合并为一行，用「涉及API」列标注全部关联 API，风险等级取其中最高（Cat 最小）。
// onlyNew=true（增量模式）：只保留本次新增的试验
function flattenTrials(ctx, onlyNew = false) {
  const raw = [];
  let seq = 0;
  Object.values(ctx.enrichedApis).forEach(api => {
    if (onlyNew && api.newTrialCount === 0) return;
    api.trials.forEach(t => {
      if (onlyNew && !t.isNew) return;
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
          const u = n.url || '';
          if (n.source === 'cde') return 'CDE 官方';
          if (n.source === 'cde+bocha') return 'CDE 官方 + 博查';
          if (!u) return '';
          try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return u; }
        })(),
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
        isNew: t.isNew ? '🆕' : '',
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
    if (!cur.regClass && r.regClass) cur.regClass = r.regClass;
    if (!cur.iec && r.iec) cur.iec = r.iec;
    if (!cur.nmpaSrc && r.nmpaSrc) cur.nmpaSrc = r.nmpaSrc;
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
    row.getCell('cat').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CAT_COLORS[r.catNum] || 'FFFFFFFF' } };
    if (r.osd) row.getCell('dosageForm').font = { bold: true };
    row.alignment = { vertical: 'top', wrapText: false };
  });
  return ws;
}

function fmtPct(n, d) { return d ? (n / d * 100).toFixed(1) + '%' : '0%'; }

// ── Sheet 1: 概览 ──
function buildOverviewSheet(wb, ctx, rows, isFull) {
  const ws = wb.addWorksheet('概览');
  ws.columns = [{ width: 34 }, { width: 92 }];
  const title = (t) => { const r = ws.addRow([t, '']); r.font = { bold: true, size: 13 }; };
  const kv = (k, v) => ws.addRow([k, v]);

  title(ctx.config.title);
  ws.addRow(['生成日期', ctx.today]);
  ws.addRow(['数据来源', String(ctx.config.source_label).replace('{version}', ctx.snap.fda_data[ctx.config.cache_version_field] || '')]);
  ws.addRow(['本次模式', isFull ? '全量（含全部商机）' : '增量（仅含本次新增商机）']);
  ws.addRow([]);

  title('总览');
  kv('FDA 亚硝胺风险 API', ctx.snap.fda_data.total_apis);
  kv('中国有临床试验的 API', ctx.apisWithLeadsCount);
  kv('商机条目（去重后试验数）', rows.length);
  kv('按 API 计条目（同一试验命中多个 API 会重复计）', isFull ? ctx.totalLeads : ctx.totalNewLeads);
  kv('本次新增', ctx.totalNewLeads);
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
    { key: 'trialCount', header: isFull ? '试验数' : '新增数', width: 8 },
    { key: 'sponsorCount', header: '企业数', width: 8 },
    { key: 'oralSolidCount', header: isFull ? 'OSD条数' : 'OSD新增数', width: 9 },
    { key: 'classDist', header: '药物分类分布', width: 32 },
    { key: 'csp', header: '推荐CSP方案', width: 34 },
    { key: 'confirm', header: '待确认', width: 18 }
  ];
  const ws = wb.addWorksheet('按API汇总');
  styleHeader(ws, cols);
  const apis = Object.values(ctx.enrichedApis)
    .filter(a => isFull || a.newTrialCount > 0)
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
      trialCount: isFull ? a.trialCount : a.newTrialCount,
      sponsorCount: a.sponsorCount,
      oralSolidCount: isFull ? a.oralSolidCount : oralNew,
      classDist,
      csp: a.csp_recommendation || '',
      confirm: a.csp_confirm || ''
    });
    row.getCell('catNum').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CAT_COLORS[a.potency_category] || 'FFFFFFFF' } };
    if (row.getCell('oralSolidCount').value > 0) row.getCell('oralSolidCount').font = { bold: true };
  });
  return ws;
}

// ── 主入口 ──
function generateWorkbook(snapshot, scenario, isFull) {
  const ctx = buildLeadModel(snapshot, scenario, isFull);
  // 增量模式：只导出本次新增（与 Markdown 报告规则一致）
  const rows = flattenTrials(ctx, !isFull);
  const suffix = isFull ? '' : '新增-';

  const wb = new ExcelJS.Workbook();
  wb.creator = 'pi_csp_agent';
  wb.created = new Date();

  buildOverviewSheet(wb, ctx, rows, isFull);
  writeTrialSheet(wb, `P1-${suffix}口服固体`, rows.filter(r => r.osd), HEADERS);
  writeTrialSheet(wb, `P2-${suffix}其他剂型`, rows.filter(r => !r.osd), HEADERS);
  writeTrialSheet(wb, `全部商机`, rows, HEADERS);
  buildApiSheet(wb, ctx, isFull);

  const xlsxPath = path.join(WS, ctx.config.report_xlsx || 'output/CSP_Leads_Report.xlsx');

  fs.mkdirSync(path.dirname(xlsxPath), { recursive: true });
  return wb.xlsx.writeFile(xlsxPath).then(() => ({
    xlsxPath,
    rows: rows.length,
    p1: rows.filter(r => r.osd).length,
    p2: rows.filter(r => !r.osd).length
  }));
}

module.exports = { generateWorkbook, flattenTrials };