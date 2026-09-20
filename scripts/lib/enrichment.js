/**
 * 通用数据富化模块（场景无关）
 *
 * 提供：剂型检测（英文/中文）、CT.gov 产品名提取、剂型解析、口服固体判定、企业识别。
 * 这些逻辑对所有使用 CT.gov + CDT 数据源的场景都一致，不包含任何场景专属知识。
 *
 * 剂型检测设计要点：
 * - 英文侧先归一化（小写 + 非字母数字→空格），用词干正则匹配，兼容复数/派生词
 *   （历史上 `\btablet\b` 匹配不到 "Tablets"、`\binhal\b` 匹配不到 "Inhalation"，导致覆盖率仅 33%）
 * - 中文侧按"先具体后笼统"的规则表匹配药名后缀；药名无后缀时回退解析试验题目
 * - resolveDosageForm 支持对历史缓存重新推断（dosageForm 为空时用已存字段重算）
 */

// ── Dosage form detection (English, from CT.gov intervention/title text) ──
function detectDosageFormEn(text) {
  if (!text) return null;
  // 归一化：小写 + 非字母数字转空格 → 词边界问题不复存在
  const t = ' ' + String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';

  const isMR = /\b(extended|sustained|controlled|delayed|modified|prolonged|slow|timed)\s?release\b|\benteric\b|\bgastro\s?resistant\b/.test(t);
  const isTablet = /\btablets?\b|\bcaplets?\b|\blozenges?\b|\bpills?\b|\bsublingual\b|\bbuccal\b|\bchewable\b|\beffervescent\b|\bdisintegrating\b/.test(t);
  const isCapsule = /\bcapsules?\b|\bsoftgels?\b|\bgelatin\s?capsules?\b/.test(t);
  const isGranule = /\bpowders?\b|\bgranules?\b|\bsachets?\b|\bsprinkles?\b/.test(t);
  const isInhalation = /\binhal(e|es|ed|ing|er|ers|ation|ations)\b|\baerosols?\b|\bnebuli[sz](e|es|ed|er|ers|ation)\b|\bdpi\b|\bmdi\b|\bpressuri[sz]ed\b/.test(t);
  const isInhalPowder = /\b(dry\s?powder|powder\s?for\s?inhalation|inhalation\s?powder|inhalation\s?powder|dpi)\b/.test(t);
  const isInjection = /\binject(ion|ions|able|ed|ing)?\b|\binfus(ion|ions|e|ed|ing)?\b|\bintravenous\b|\bsubcutaneous\b|\bintramuscular\b|\bvials?\b|\bprefilled\b|\bsyringes?\b|\bliophili[sz]ed\b/.test(t);
  const isOphthalmic = /\bophthalmic\b|\bocular\b|\beye\s?drops?\b|\bintravitreal\b/.test(t);
  const isNasal = /\bnasal\b|\bintranasal\b|\bnose\s?sprays?\b/.test(t);
  const isTopical = /\b(creams?|ointments?|gels?|lotions?|foams?|pastes?|shampoos?|emulgels?)\b|\btopical\b|\btransdermal\b|\bpatches?\b|\bcutaneous\b|\bvaginal\b/.test(t);
  const isSuppository = /\bsuppositor(y|ies)\b|\benemas?\b|\brectal\b/.test(t);
  const isOralLiquid = /\b(syrups?|suspensions?|emulsions?|elixirs?|drops?|liquids?)\b|\boral\s?(solution|suspension)/.test(t);
  const isOral = /\boral(ly)?\b/.test(t);

  if (isMR) {
    if (isTablet) return '改良释放制剂(片剂)';
    if (isCapsule) return '改良释放制剂(胶囊)';
    if (isGranule) return '改良释放制剂(颗粒)';
    return '改良释放制剂';
  }
  if (isInhalation) return isInhalPowder ? '吸入制剂(粉末)' : '吸入制剂';
  if (isInjection) return '注射制剂';
  if (isOphthalmic) return '眼用制剂';
  if (isNasal) return '鼻用制剂';
  if (isTablet) return '口服固体制剂(片剂)';
  if (isCapsule) return '口服固体制剂(胶囊)';
  if (isGranule) return isOral ? '口服固体制剂(颗粒/散剂)' : '口服固体制剂(颗粒/散剂)';
  if (isTopical) return '外用制剂';
  if (isOralLiquid) return '口服液体制剂';
  if (isSuppository) return '栓剂';
  if (isOral) return '口服制剂';
  return null;
}

// ── Extract product name from CT.gov interventions (match API keyword) ──
function extractProductName(interventions, apiName) {
  const drugs = interventions.filter(iv => iv.type === 'DRUG');
  if (drugs.length === 0) return '';
  const apiLower = apiName.toLowerCase();
  const exactMatch = drugs.find(iv => {
    const name = (iv.name || '').toLowerCase();
    return name.includes(apiLower) || apiLower.includes(name.replace(/[\s-]/g, ''));
  });
  if (exactMatch) return exactMatch.name;
  const fuzzyMatch = drugs.find(iv => {
    const text = ((iv.name || '') + ' ' + (iv.description || '')).toLowerCase();
    return text.includes(apiLower);
  });
  if (fuzzyMatch) return fuzzyMatch.name;
  if (drugs.length === 1) return drugs[0].name || '';
  return drugs[0].name || '';
}

// ── Extract dosage form from CT.gov intervention + title text ──
function extractDosageForm(interventions, briefTitle, officialTitle) {
  const allTexts = [];
  (interventions || []).filter(iv => iv.type === 'DRUG').forEach(iv => {
    if (iv.name) allTexts.push(iv.name);
    if (iv.description) allTexts.push(iv.description);
  });
  if (officialTitle) allTexts.push(officialTitle);
  if (briefTitle) allTexts.push(briefTitle);
  return detectDosageFormEn(allTexts.join(' '));
}

// ── 中文剂型规则表（顺序敏感：先具体后笼统）──
const CN_DOSAGE_RULES = [
  // 特殊/局部给药：必须先于"溶液/凝胶/喷雾/片"等泛化词
  [/滴眼液|滴眼剂|眼用|眼膏|眼药水|眼内|玻璃体腔/, '眼用制剂'],
  [/鼻喷|鼻用|滴鼻|鼻腔|鼻部/, '鼻用制剂'],
  [/吸入用粉雾剂|粉雾剂|干粉吸入|吸入粉雾剂|吸入用胶囊/, '吸入制剂(粉末)'],
  [/吸入|雾化吸入|气雾剂/, '吸入制剂'],
  [/注射液|注射用|注射剂|粉针|冻干|微球|脂质体|无菌粉末/, '注射制剂'],
  // 外用（含贴剂/膜剂——注意要在"片"之前，避免"贴片"被识别为口服片剂）
  [/贴剂|贴片|贴膏|膜剂|巴布膏|软膏|乳膏|乳胶剂|凝胶|搽剂|涂剂|外用|喷雾剂|洗剂|散剂\(外用\)/, '外用制剂'],
  // 口服固体
  [/片|丸剂|滴丸|微丸|含片|胶丸/, '口服固体制剂(片剂)'],
  [/胶囊|软胶囊/, '口服固体制剂(胶囊)'],
  [/颗粒|冲剂|散剂|粉剂|干混悬剂|细粒/, '口服固体制剂(颗粒/散剂)'],
  // 口服液体
  [/口服溶液|口服液|口服混悬|混悬液|糖浆|酊剂|口服乳剂|胶浆|口服滴剂|滴剂|溶液剂/, '口服液体制剂'],
  // 栓剂
  [/栓剂|栓\b/, '栓剂'],
  // 口服兜底
  [/口服/, '口服制剂']
];

// ── Dosage form extraction from Chinese text (CDT drugName 或试验题目) ──
function extractDosageFormCN(text) {
  if (!text) return null;
  const name = String(text).trim();

  // 改良释放特征最先判定（保留细分剂型）
  if (/缓释|控释|肠溶|迟释|长效|缓控释|速释/.test(name)) {
    if (/片|丸/.test(name)) return '改良释放制剂(片剂)';
    if (/胶囊|胶丸/.test(name)) return '改良释放制剂(胶囊)';
    if (/颗粒|散|粉/.test(name)) return '改良释放制剂(颗粒)';
    return '改良释放制剂';
  }
  for (const [re, form] of CN_DOSAGE_RULES) {
    if (re.test(name)) return form;
  }
  return null;
}

// ── Unified dosage form resolver ──
// CDT：药名后缀 → 试验题目回退
// CT.gov：入库时已提取；为空或仅为笼统值（"口服制剂"）时，用已存文本重新推断
//          （笼统值历史上由旧正则产生，会挡住更准确的推断）
const VAGUE_FORMS = new Set(['口服制剂', '其他', '未识别']);

function resolveDosageForm(t) {
  if (!t) return null;
  const stored = t.dosageForm || null;
  const storedUseful = stored && !VAGUE_FORMS.has(stored);

  if (t.source === 'CDT') {
    if (storedUseful) return stored;
    return extractDosageFormCN(t.drugName)
        || extractDosageFormCN(t.briefTitle)
        || extractDosageFormCN(t.officialTitle)
        || stored;
  }
  if (storedUseful) return stored;
  const derived = detectDosageFormEn([t.drugName, t.briefTitle, t.officialTitle].filter(Boolean).join(' '));
  return derived || stored;
}

// ── Is oral solid? (CSP 重点关注剂型) ──
function isOralSolid(form) {
  if (!form) return false;
  return /口服固体|改良释放/.test(form);
}

// ── 剂型大类 → 场景配置里的分组键（scenario.json → dosage_form_groups）──
function dosageFormGroup(form, config) {
  if (!form) return 'unknown';
  const map = (config && config.dosage_form_groups) || {};
  if (map[form]) return map[form];
  // 前缀兜底：改良释放制剂(片剂) → 找 改良释放 开头的键
  const key = Object.keys(map).find(k => form.startsWith(k));
  return key ? map[key] : 'unknown';
}

// ── Enterprise filter (identify pharmaceutical companies vs hospitals/universities/individuals) ──
// CDT 数据来自药企申报，默认全部为企业；CT.gov 申办方包含医院、大学、个人，需要过滤。
const EN_ENTERPRISE_KW = [
  'Pharma', 'Pharmaceutical', 'Bio', 'Biotech', 'Labs', 'Laboratories',
  'Therapeutics', 'Inc', 'Ltd', 'LLC', 'Corp', 'Co.', 'Co,', 'GmbH',
  'Medicines', 'Medicine', 'Healthcare', 'Life Sciences', 'Sciences', 'Technology',
  'Company', 'Group'
];
const KNOWN_ENTERPRISES = new Set([
  'AbbVie', 'AstraZeneca', 'Bayer', 'Boehringer Ingelheim',
  'Bristol-Myers Squibb', 'Daiichi Sankyo', 'Eisai', 'Eli Lilly',
  'Eli Lilly and Company', 'Gilead', 'GlaxoSmithKline',
  'Johnson & Johnson', 'Merck', 'MSD', 'Novartis',
  'Novartis Pharmaceuticals', 'Otsuka', 'Pfizer', 'Regeneron',
  'Roche', 'Sanofi', 'Takeda', 'Vertex',
  'SciClone Pharmaceuticals', 'BeiGene', 'Innovent Biologics',
  'Hengrui Medicine', 'Hansoh Pharma', 'Akeso', 'Genmab',
  'Hutchmed', 'Jemincare', 'Longbio Pharma', 'Vivalink', 'Amzell',
  'Chiesi Farmaceutici S.p.A.', 'Inmunotek S.L.'
]);

function isEnterprise(sponsor) {
  if (!sponsor || sponsor.length < 2) return false;
  if (KNOWN_ENTERPRISES.has(sponsor)) return true;

  if (/[\u4e00-\u9fff]/.test(sponsor)) {
    // CN: enterprise keywords take priority (handles "XX制药研究院" etc.)
    if (/制药|药业|医药|生物|药品|科技|股份|公司|集团|健康|医疗|生命/.test(sponsor)) return true;
    // CN: clearly non-enterprise
    if (/医院|大学|学院|研究所|研究院|中心|学校|学会|协会|基金|卫生|疾控/.test(sponsor)) return false;
    return false; // Unknown Chinese entity → exclude from CT.gov
  }

  // EN: non-enterprise patterns first (prevents "Beijing University of Technology" false positive)
  if (/University|College|Hospital|Clinic|Institute|Academy|School|Foundation|Center|Centre|Laboratory|Department of|Ministry of/i.test(sponsor)) return false;
  // EN: enterprise keywords
  if (EN_ENTERPRISE_KW.some(kw => sponsor.includes(kw))) return true;
  // Individual name patterns (conservative: only exclude clear personal names)
  if (/^([A-Z][a-z]+[- ]){1,2}[A-Z][a-z]+$/.test(sponsor)) return false;  // Bai-Rong Xia
  if (/^[A-Z][a-z]+,\s*[A-Z]/.test(sponsor)) return false;               // Dai, Guanghai
  if (/,\s*(MD|PhD|Dr|Professor|M\.D\.)/i.test(sponsor)) return false;   // kewen Chen,MD
  if (/^[a-z]/.test(sponsor)) return false;                               // aijun xu, meishanshan
  if (/^[A-Z][a-z]+$/.test(sponsor)) return false;                        // single word like "meishanshan"
  if (/^[A-Z][a-z]+ [a-z]/.test(sponsor)) return false;                    // Qiu jinpeng, Wang wanxia
  if (/^[A-Z][a-z]+-[a-z]+ [A-Z]/.test(sponsor)) return false;             // Xiao-dong Zhuang
  if (/^[a-z]+[A-Z][a-z]*\s/.test(sponsor)) return false;                  // (lowercase prefix)
  if (/^[A-Z][a-z]+[A-Z][a-z]+\s/.test(sponsor) && sponsor.split(/\s+/).length <= 2) return false; // YanYing Xiao (camelCase first name + last name)
  if (/^[A-Z][a-z]+[A-Z][a-z]+$/.test(sponsor) && sponsor.length <= 10) return false; // WeiShi (camelCase pinyin)
  return true; // Unknown English → include (conservative)
}

module.exports = {
  detectDosageFormEn,
  extractProductName,
  extractDosageForm,
  extractDosageFormCN,
  resolveDosageForm,
  isOralSolid,
  dosageFormGroup,
  isEnterprise
};