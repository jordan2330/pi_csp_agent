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
  { key: 'apiCn', header: 'API(中文)', width: 16 },
  { key: 'apiEn', header: 'API(英文)', width: 20 },
  { key: 'aiLimit', header: 'AI Limit', width: 12 },
  { key: 'sponsor', header: '申请人/企业', width: 30 },
  { key: 'drugName', header: '产品名称', width: 26 },
  { key: 'dosageForm', header: '剂型', width: 20 },
  { key: 'drugClass', header: '药物分类', width: 14 },
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

// ── 把 model 变成"一行一条试验"的扁平记录 ──
// onlyNew=true（增量模式）：只保留本次新增的试验
function flattenTrials(ctx, onlyNew = false) {
  const rows = [];
  Object.values(ctx.enrichedApis).forEach(api => {
    if (onlyNew && api.newTrialCount === 0) return;
    api.trials.forEach(t => {
      if (onlyNew && !t.isNew) return;
      const isOsd = isOralSolid(t.dosageForm);
      rows.push({
        osd: isOsd,
        priority: isOsd ? `P1-OSD-Cat${api.potency_category}` : `P2-其他-Cat${api.potency_category}`,
        cat: `Cat ${api.potency_category}`,
        catNum: api.potency_category,
        apiCn: api.name_cn || api.name_en,
        apiEn: api.name_en,
        aiLimit: api.ai_limit,
        sponsor: t.sponsor || '',
        drugName: t.drugName || '',
        dosageForm: t.dosageForm || '未识别',
        drugClass: t.drugClassification || '未分类',
        csp: api.csp_recommendation || '',
        confirm: api.csp_confirm || '',
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
        _trialCount: api.trialCount
      });
    });
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
  kv('商机条目（试验数）', isFull ? ctx.totalLeads : rows.length);
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

  title('药物分类分布');
  const classCount = {};
  rows.forEach(r => { classCount[r.drugClass] = (classCount[r.drugClass] || 0) + 1; });
  Object.entries(classCount).sort((a, b) => b[1] - a[1]).forEach(([c, n]) => kv(c, `${n} 条 (${fmtPct(n, rows.length)})`));
  ws.addRow([]);

  title('怎么用');
  [
    '1. 销售先看 P1-口服固体：Cat 1 排在最前（AI limit 最严 → 亚硝胺风险最高 → CSP 价值最大）',
    '2. 需要 OSD+Cat1 单独视图：在 P1 sheet 用「风险等级」列筛选 = Cat 1 即可',
    '3. 做透视表/图表：用「全部商机」sheet（一行 = 一条试验，字段扁平）',
    '4. 管理视角（每 API 多少家企业/多少条试验）：看「按API汇总」',
    '5. 推荐方案按剂型给出「候选组合」，并标注需向客户确认的信息（如泡罩线 vs 瓶装线）'
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