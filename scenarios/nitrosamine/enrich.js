/**
 * 亚硝胺场景专属 hooks（命令式逻辑）
 *
 * 这些函数逐字移植自重构前的报告生成逻辑，保证输出零回归。
 * 通用 report.js 通过约定接口调用它们；将来其他场景提供自己的 enrich.js。
 *
 * hooks：
 *   classifyTrial(trial)            → 药物分类（仿制药/原研药/新药/改良新药/观察性研究）
 *   recommendCSP(api, config)       → CSP 推荐方案：{ text, confirm }（以剂型为主，见下）
 *   newLeadSubtitle(api, config)     → 新增商机小标题行（> ...）
 *   fullLeadSubtitle(api, config)    → 全量商机小标题行（> ...）
 *   categoryHeader(cat, config)      → 风险分类标题（### ...）
 *   renderOverview(ctx)              → 概览整段（含剂型分布等场景专属统计）
 *   snapshotExtras(fda)              → 快照 fda_data 的场景专属字段
 */

// ── Known originator companies ──
// 说明：CDT 的申办方字段常是多个主体的拼接（如 "Pfizer Inc./ 辉瑞（北京）研究开发有限公司/"），
//       所以用**关键词包含匹配**（英文名 + 中文名）而不是集合精确匹配，否则跨国药企的中文实体会被漏判。
const ORIGINATOR_KEYWORDS = [
  // 英文
  'Bayer', 'Novartis', 'Sanofi', 'AstraZeneca', 'Pfizer', 'Eli Lilly', 'Merck', 'MSD',
  'GlaxoSmithKline', 'Roche', 'Genentech', 'AbbVie', 'Abbott', 'Johnson & Johnson', 'Janssen',
  'Amgen', 'Boehringer', 'Takeda', 'Daiichi Sankyo', 'Otsuka', 'Eisai', 'Astellas', 'Gilead',
  'Biogen', 'Regeneron', 'Vertex', ' Novo ', 'Bristol-Myers', 'Bristol Myers', 'Lundbeck',
  'UCB', 'Servier', 'Teva', 'Sandoz', 'Mylan', 'Sun Pharma', 'Chiesi', 'Bracco', 'Meiji',
  // 中文（跨国药企在华实体）
  '辉瑞', '诺华', '阿斯利康', '赛诺菲', '默沙东', '默克', '礼来', '拜耳', '勃林格',
  '葛兰素', '罗氏', '武田', '大冢', '卫材', '诺和诺德', '诺和', '强生', '杨森',
  '艾伯维', '安进', '吉利德', '第一三共', '参天', '灵北', '优时比', '施维雅',
  '贝朗', '费森尤斯', '梯瓦', '山德士', '中外制药', '大鹏药品', '协和麒麟'
];

// 是否为原研企业（申办方字符串包含任一关键词）
function isOriginatorCompany(sponsor) {
  const s = String(sponsor || '');
  if (!s) return false;
  return ORIGINATOR_KEYWORDS.some(k => s.includes(k));
}

// ── Drug classification inference ──
// ── 中文期次解析 ──
// CDT 的 phase 写法多样："I期" / "其他说明:Ib/II" / "其他说明:Ib/IIa" / "其他说明:药代动力学比较试验"（非期次）
// 返回 { late }（late=II/III/IV 期）或 null（无法解析为期次）
function parseCnPhase(phase) {
  const s = String(phase || '');
  const m = s.match(/其他说明[:：]\s*([^\s]+)/);
  const token = (m ? m[1] : s).trim();
  const pm = token.match(/^(I{1,3}[abAB]?|IV)(?:\s*\/\s*(I{1,3}[abAB]?|IV))?期?$/);
  if (!pm) return null;
  const late = /^(II|III|IV)/.test(pm[1]) || /^(II|III|IV)/.test(pm[2] || '');
  return { late };
}

// ── Drug classification inference（规则基于真实 phase/trialType 取值）──
//   CDT: phase="其它 其他说明:生物等效性试验" | "I期/II期/III期"（trialType 含 生物等效/药代动力学/安全性和有效性）
//   CT.gov: phase="PHASE1/2/3/4" | "NA" | ""（trialType: INTERVENTIONAL / OBSERVATIONAL）
/**
 * 药物分类（**只留实锤，不做推断**，v4.2.0）
 *
 * 设计原则：宁可留空让销售人工核对，也不要推断标签。
 *   - 只做"事实搬运"：注册平台明确标 OBSERVATIONAL 的试验 → 标为观察性（注册事实，非推断）
 *   - 其余返回空字符串：真正的药物分类只能来自 CDE 官方受理记录（见 refineClassifications）
 */
function classifyTrial() {
  return '';   // 药物分类列只放 CDE 实锤证据（见 refineClassifications）；观察性等试验设计信息放在「分期」列
}

function recommendCSP(api, config) {
  const map = config.csp_by_dosage_group || {};
  const entry = map[api.dosageGroup];
  if (entry && entry.candidates && entry.candidates.length > 0) {
    return { text: entry.candidates.join(' / '), confirm: entry.confirm || null };
  }
  // 兜底：剂型未知 → 回到按风险等级（历史行为）
  const byCat = (config.category.csp_by_category || {})[api.potency_category];
  return byCat ? { text: byCat, confirm: '剂型/包装形态' } : { text: '需评估', confirm: '剂型/包装形态' };
}

// ── Subtitle 片段：推荐方案 + 待确认项 ──
function cspPart(api) {
  if (!api.csp_recommendation) return '';
  let s = `推荐CSP方案: **${api.csp_recommendation}**`;
  if (api.csp_confirm) s += `（待确认: ${api.csp_confirm}）`;
  return s;
}

// ── 产品名归一（去空格/全角空格/标点 + 小写），用于跨 API、跨企业的同名产品归并 ──
function normalizeProductName(name) {
  return String(name || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[（）()\[\]【】"'“”·、；;,，]/g, '')
    .toLowerCase();
}

// ── 分类一致性修正（批量，通用层在逐试验分类后调用）──
// 背景：同一产品在不同试验里可能得到不同标签——例：同一企业的同品种，
//       BE 试验判为"仿制药"，而 IV 期（上市后）试验被判为"新药"，销售看到同药两种口径。
// 规则：① 同一产品名只要有一次 BE/一致性评价证据 → 该产品（非原研企业）统一为"仿制药"
//       ② 非原研企业的 IV 期试验 → "仿制药"（已上市产品，多数为仿制/已获批）
//       ③ 同一（企业, 产品）组内标签不一致时，按多数票 + 业务优先级统一
/**
 * 药物分类应用（**只应用实锤证据**，v4.2.0）
 *
 * 证据：CDE 官方受理品种信息（scripts/lib/cde-classify.js），两级：
 *   level='product' = 试验产品名精确/包含命中某条 CDE 受理记录 → 该产品自己的注册分类（最可靠）
 *   level='api'     = 只查到"品种"级受理记录（非该产品）
 *
 * 不套用品种级证据的例外：原研企业申办、代码号在研新药（CDE 不可能有该产品记录）
 * 无实锤证据 → 留空（不推断）
 */
function refineClassifications(trials) {
  const CODE_NAME = /^[A-Za-z][A-Za-z0-9\-]{2,}$|[A-Za-z]{2,}[- ]?\d{2,}/;
  for (const t of trials) {
    const n = t.nmpa;
    if (!n || !n.label) { t.drugClassification = ''; continue; }
    const name = String(t.drugName || '').trim();
    if (n.level === 'api' && (isOriginatorCompany(t.sponsor) || CODE_NAME.test(name))) {
      if (t.drugClassification !== '观察性研究') t.drugClassification = '';                       // 品种级证据不适用 → 显式留空
      continue;
    }
    t.drugClassification = n.label;
  }
}

function snapshotExtras(fda) {
  return {
    api_count_with_nitrosamines: Object.values(fda.apis).filter(a => (a.nitrosamines || []).length > 0).length
  };
}

module.exports = {
  classifyTrial,
  refineClassifications,
  normalizeProductName,
  isOriginatorCompany,
  recommendCSP,
  snapshotExtras
};
