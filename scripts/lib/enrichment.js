/**
 * 通用数据富化模块（场景无关）
 *
 * 提供：剂型检测（英文/中文）、CT.gov 产品名提取、剂型解析、口服固体判定。
 * 这些逻辑对所有使用 CT.gov + CDT 数据源的场景都一致，不包含任何场景专属知识。
 */

// ── Dosage form detection (English, from CT.gov Intervention text) ──
function detectDosageFormEn(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/extended[\s-]?release|sustained[\s-]?release|controlled[\s-]?release|delayed[\s-]?release|modified[\s-]?release/.test(t)) return '改良释放制剂';
  if (/\b(tablet|tab\b|caplet|pill|lozenge)\b/.test(t)) return '口服固体制剂(片剂)';
  if (/\b(capsule|cap\b)\b/.test(t)) return '口服固体制剂(胶囊)';
  if (/\b(powder|granule|sachet)\b/.test(t) && /\boral\b/.test(t)) return '口服固体制剂(颗粒/散剂)';
  if (/\boral\b/.test(t) && /\b(solution|suspension|syrup|liquid|drop|elixir)\b/.test(t)) return '口服液体制剂';
  if (/\bsyrup\b/.test(t)) return '口服液体制剂';
  if (/\boral\b/.test(t) && !/\b(inject|infus|iv\b|topical|cream|ointment|nasal|eye|ophthalm)\b/.test(t)) return '口服制剂';
  if (/\b(dry\s*powder\s*inhal|dpi\b|metered[\s-]?dose\s*inhal|mdi\b|pressurized\s*inhal)\b/.test(t)) return '吸入制剂(粉末)';
  if (/\b(inhal|aerosol|nebuli|inhaler)\b/.test(t)) return '吸入制剂';
  if (/\b(inject|infus|iv\b|intraven|subcutan|sc\b|intramus|im\b)\b/.test(t)) return '注射制剂';
  if (/\b(cream|ointment|gel\b|lotion|topical|patch|transdermal)\b/.test(t)) return '外用制剂';
  if (/\b(nasal\s*spray|nasal\s*powder|intranasal)\b/.test(t)) return '鼻用制剂';
  if (/\b(nasal)\b/.test(t)) return '鼻用制剂';
  if (/\b(eye|ophthalm|ocular|eyedrop)\b/.test(t)) return '眼用制剂';
  if (/\b(suppositor)\b/.test(t)) return '栓剂';
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
  interventions.filter(iv => iv.type === 'DRUG').forEach(iv => {
    if (iv.name) allTexts.push(iv.name);
    if (iv.description) allTexts.push(iv.description);
  });
  if (officialTitle) allTexts.push(officialTitle);
  if (briefTitle) allTexts.push(briefTitle);
  const combined = allTexts.join(' ');
  const form = detectDosageFormEn(combined);
  if (form) return form;
  if (/\boral\b/i.test(combined)) return '口服制剂';
  return null;
}

// ── Dosage form extraction from CDT drugName (Chinese suffix) ──
function extractDosageFormCN(drugName) {
  if (!drugName) return null;
  const name = drugName.trim();

  // Modified release (highest priority signal)
  if (/缓释|控释|肠溶|迟释|长效/.test(name)) {
    if (/片/.test(name)) return '改良释放制剂(片剂)';
    if (/胶囊/.test(name)) return '改良释放制剂(胶囊)';
    if (/颗粒/.test(name)) return '改良释放制剂(颗粒)';
    return '改良释放制剂';
  }

  // Oral solids — CSP primary interest
  if (/片/.test(name) && !/注射|外用|吸入|滴眼|鼻喷|软膏|乳膏|凝胶|贴剂/.test(name)) return '口服固体制剂(片剂)';
  if (/胶囊/.test(name) && !/注射|外用|吸入|滴眼|鼻喷/.test(name)) return '口服固体制剂(胶囊)';
  if (/(颗粒|冲剂|散剂|粉剂|干混悬剂)/.test(name) && !/注射|外用|吸入|滴眼/.test(name)) return '口服固体制剂(颗粒/散剂)';
  if (/丸剂|滴丸|微丸/.test(name)) return '口服固体制剂(丸剂)';

  // Oral liquids
  if (/口服溶液|口服液|糖浆|混悬液|口服混悬|乳剂|酊剂/.test(name)) return '口服液体制剂';

  // Generic oral (catch-all for 口服 but not clearly solid/liquid)
  if (/口服/.test(name) && !/注射|外用|吸入|滴眼|鼻喷/.test(name)) return '口服制剂';

  // Inhalation (match broadly — 吸入/雾化吸入 anywhere in name)
  if (/吸入|雾化吸入|气雾剂|喷雾剂|粉雾剂|干粉吸入/.test(name)) {
    if (/粉雾|干粉|粉末/.test(name)) return '吸入制剂(粉末)';
    return '吸入制剂';
  }

  // Injection
  if (/注射液|注射用|注射剂|粉针|冻干粉针/.test(name)) return '注射制剂';

  // Nasal (CSP secondary interest)
  if (/鼻喷|鼻用|滴鼻|鼻腔/.test(name)) return '鼻用制剂';

  // Topical / transdermal
  if (/软膏|乳膏|凝胶|贴剂|贴片|搽剂|涂剂|外用溶液|外用/.test(name)) return '外用制剂';

  // Ophthalmic
  if (/滴眼液|眼用|眼膏|眼药水/.test(name)) return '眼用制剂';

  // Suppository
  if (/栓剂/.test(name)) return '栓剂';

  return null;
}

// ── Unified dosage form resolver (CT.gov pre-extracted, or CDT from CN drugName) ──
function resolveDosageForm(t) {
  // If already extracted during CT.gov fetch
  if (t.dosageForm) return t.dosageForm;
  // CDT: extract from Chinese drugName
  if (t.source === 'CDT') {
    return extractDosageFormCN(t.drugName);
  }
  return null;
}

// ── Is oral solid? (for highlighting) ──
function isOralSolid(form) {
  if (!form) return false;
  return /口服固体|改良释放|口服固体制剂/.test(form);
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

// ── Extract phase string from CT.gov designModule.phases array ──
function extractPhaseFromCTGov(phasesArray) {
  if (!Array.isArray(phasesArray) || phasesArray.length === 0) return '';
  return phasesArray.join(', ');
}

module.exports = {
  detectDosageFormEn,
  extractProductName,
  extractDosageForm,
  extractDosageFormCN,
  resolveDosageForm,
  isOralSolid,
  isEnterprise,
  extractPhaseFromCTGov
};
