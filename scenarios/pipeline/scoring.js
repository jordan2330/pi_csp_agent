#!/usr/bin/env node
/**
 * 管线/交易场景 —— 资格评分卡（纯函数，无 I/O）
 *
 * 依据：research/pipeline-business-fit.md §6（7 维 × 0-3 分，D1/D2/D4 各 ×2，满分 30）+ §6.2 三道硬闸门
 * 设计要点：
 *   - 只有「有证据表明不匹配」才出局（G1/G3）；**剂型未知不丢弃**，只计 0 分
 *   - 分档阈值随「可计算的维度」缩放：lite = D1+D2+D3（满分 15），full = 27
 *   - D4-D7 需要企业属性/融资/决策权数据，本版返回 null（不猜、不计入分母）
 *
 * 自检：node scenarios/pipeline/scoring.js   （跑内置 assert）
 */

const path = require('path');

// ── G1 形态闸门：CSP 无对应产品线（注射/无菌/液体给药/生物药）──
const G1_FORM = /(注射|冻干|粉针|输液|滴眼|气雾|喷雾剂|预灌封|凝胶|栓|植入)/;
const G1_CLASS = /(单抗|抗体|ADC|双抗|融合蛋白|疫苗|mRNA|细胞治疗|基因治疗|血液制品|生物制品)/i;

// ── D1 剂型匹配度 ──
function dosageScore(drugName = '') {
  if (/颗粒|散剂|口服粉|粉剂|干混悬/.test(drugName)) return { score: 3, form: '颗粒/散剂/干混悬' };
  if (/胶囊/.test(drugName)) return { score: 3, form: '胶囊（含胶囊型吸入）' };
  if (/片/.test(drugName)) return { score: 2, form: '片剂' };
  if (/溶液|混悬|口服液|糖浆|软膏|贴/.test(drugName)) return { score: 1, form: '溶液/膏/贴' };
  return { score: 0, form: null };              // 剂型待定：不猜、也不丢
}

// ── D2 理化风险（真实购买驱动，权重最高）──
function physchemScore({ drugName = '', apiName = '', onNitrosamineList = false, consistencyEvaluated = false }) {
  const strong = [];          // 3 分档：强痛点
  if (onNitrosamineList) strong.push('亚硝胺清单命中');
  if (/肽|蛋白|多肽/.test(drugName) && /片|胶囊|颗粒|散/.test(drugName)) strong.push('口服肽/蛋白固体');
  if (/益生菌|活菌|微生态/.test(drugName)) strong.push('活菌制剂');
  if (/浸膏|提取物/.test(drugName)) strong.push('中药浸膏（强引湿）');
  if (strong.length) return { score: 3, reasons: strong };

  const medium = [];          // 2 分档
  if (/(缓释|控释|肠溶|迟释)/.test(drugName)) medium.push('缓控释/肠溶');
  if (/复方/.test(drugName)) medium.push('复方');
  if (/^(阿莫西林|阿奇霉素|克拉霉素|罗红霉素|头孢|青霉素|奥美拉唑|泮托拉唑|兰索拉唑|维生素|布地奈德|福莫特罗)/.test(apiName)) medium.push('引湿/氧敏类别');
  if (medium.length) return { score: 2, reasons: medium };

  if (consistencyEvaluated) return { score: 0, reasons: ['已完成一致性评价的成熟仿制'] };
  return { score: 1, reasons: ['普通速释制剂（无已知痛点）'] };   // 默认 1
}

// ── D3 临床阶段 ──
function phaseScore(phaseText = '') {
  const t = String(phaseText);
  if (/III期|III 期|3期|PHASE3|关键临床|NDA|上市申请/i.test(t)) return { score: 3, phase: 'III期/NDA' };
  if (/II期|II 期|2期|PHASE2/i.test(t)) return { score: 2, phase: 'II期' };
  if (/I期|I 期|1期|PHASE1|EARLY_PHASE1|IND/i.test(t)) return { score: 1, phase: 'I期/IND' };
  if (/观察性|OBSERVATIONAL/i.test(t)) return { score: 0, phase: '观察性' };
  return { score: 0, phase: null };             // 无期次信息：0 分，不算出局
}

// ── D5 事件强度（期次 + 受理号类型 + 近期动态）──
// 受理号第 4 位：L=临床试验申请（IND）、S=上市申请（NDA）；具体见 CXHL/CXHS/JXHL/JXHS
function eventScore({ regNo = '', phaseRank = 0 }) {
  const reasons = [];
  const isNda = /^[A-Z]{3}S/.test(String(regNo));
  const isInd = /^[A-Z]{3}L/.test(String(regNo));
  let score = 0;
  if (phaseRank >= 3 || isNda) { score = 3; reasons.push(isNda ? 'NDA 已受理' : 'III期/关键临床'); }
  else if (phaseRank === 2) { score = 2; reasons.push('II期'); }
  else if (phaseRank === 1 || isInd) { score = 1; reasons.push(isInd ? 'IND 已受理' : 'I期'); }
  if (!score) reasons.push('无阶段信号');
  return { score, reasons };
}

// ── D6 决策权归属（申请人是否中国主体）──
// 进口申请（J 开头）的持证人多在境外；在华子公司含 (China)/(中国) 时视为有本地决策
function decisionScore({ company = '' }) {
  const cn = /[\u4e00-\u9fff]/.test(company);
  const legal = /(有限公司|股份有限公司|药业|制药|医药|生物)/.test(company);
  const localBranch = /[（(]\s*(中国|China)\s*[）)]|China/i.test(company);
  if (cn && legal && !/^(中国|China)/i.test(company)) return { score: 3, reason: '中国主体（自有持证）' };
  if (!cn && localBranch) return { score: 2, reason: '外企在华子公司' };
  if (!cn) return { score: 1, reason: '境外主体（决策多在海外）' };
  return { score: 2, reason: '中文主体（持证身份待确认）' };
}

// ── D4 企业规模（销售指定的大客户清单；×2 权重）──
let _bigpharma;
function bigpharma() {
  if (_bigpharma === undefined) {
    try { _bigpharma = require(path.join(__dirname, '..', '..', 'config', 'pipeline-bigpharma.json')); }
    catch { _bigpharma = { groups: {}, non_enterprise: [] }; }
  }
  return _bigpharma;
}
// 匹配前把括号备注剥掉：CDE 里出现过「某公司(预填充注射笔的组装…: 江苏恒瑞…)」这类脏值
const bareName = (c) => String(c || '').replace(/[（(][^）)]{6,}[）)]/g, '');

function scaleScore({ company = '' }) {
  const cfg = bigpharma();
  const name = bareName(company);
  for (const [group, g] of Object.entries(cfg.groups || {})) {
    if ((g.aliases || []).some(a => name.includes(a))) return { score: 3, reason: `大客户集团命中「${group}」`, group };
  }
  if (new RegExp((cfg.non_enterprise || []).join('|')).test(name)) return { score: 0, reason: '非企业主体（高校/医院/院所）' };
  return { score: 1, reason: '中小企业/Biotech（未命中大客户清单）' };
}

// ── D7 可联系性（CT.gov 公开联系渠道的**类型**，不落个人联系方式）──
// 3=企业域邮箱 2=通用联络渠道(电话/call center) 1=仅研究机构/负责人 0=无
function contactScore({ d7 } = {}) {
  const n = Number(d7);
  if (!Number.isFinite(n)) return { score: 0, reason: '未查联系方式' };
  const label = { 3: '有企业域邮箱', 2: '有通用联络渠道', 1: '仅研究机构/负责人', 0: '无公开联系渠道' }[n] || '未知';
  return { score: n, reason: label };
}

// ── 闸门 ──
function gates({ drugName = '', regClass = '', drugClass = '' }) {
  if (G1_FORM.test(drugName) || G1_CLASS.test(drugClass)) return { excluded: true, gate: 'G1-形态不符（CSP 无产品线）' };
  if (/原料药|中间体/.test(regClass)) return { excluded: true, gate: 'G3-原料药' };
  return { excluded: false, gate: null };
}

// ── 分档（阈值随可算维度缩放）──
const MODES = {
  lite: { dims: ['D1', 'D2', 'D3'], max: 15, tiers: [[11, 'A'], [8, 'B'], [5, 'C']] },
  full: { dims: ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'], max: 30, tiers: [[20, 'A'], [16, 'B'], [12, 'C']] }   // D4 ×2（大客户优先）+ D7 可用 → 满分 30；阈值按 1125 行分布校准：A 86 / B 293 / C 312
};

function tierOf(points, mode = 'lite') {
  for (const [min, t] of MODES[mode].tiers) if (points >= min) return t;
  return 'D';
}

/**
 * @param row {{ drugName, apiName, regClass, drugClass, onNitrosamineList, phase, d4,d5,d6,d7 }}
 * @param opts {{ mode: 'lite'|'full' }}
 */
function score(row = {}, opts = {}) {
  const mode = opts.mode || 'lite';
  const g = gates(row);
  if (g.excluded) return { excluded: true, gate: g.gate, points: 0, max: MODES[mode].max, tier: 'D', dims: {}, notes: [] };

  const D1 = dosageScore(row.drugName);
  const D2 = physchemScore(row);
  const D3 = phaseScore(row.phase);
  const dims = { D1: D1.score, D2: D2.score, D3: D3.score };
  const notes = [...D2.reasons];
  let points = 2 * D1.score + 2 * D2.score + D3.score;

  if (mode === 'full') {
    const D4 = scaleScore({ company: row.company });
    const D5 = eventScore({ regNo: row.regNo, phaseRank: D3.score });
    const D6 = decisionScore({ company: row.company });
    const D7 = contactScore({ d7: row.d7 });
    dims.D4 = D4.score; dims.D5 = D5.score; dims.D6 = D6.score; dims.D7 = D7.score;
    points += 2 * D4.score + D5.score + D6.score + D7.score;   // D4 与 D1/D2 同权重（销售要求大客户加权）
    notes.push(`D4=${D4.score}(${D4.reason})`, `D5=${D5.score}(${D5.reasons.join('/')})`, `D6=${D6.score}(${D6.reason})`, `D7=${D7.score}(${D7.reason})`);
  }
  if (!D1.form) notes.push('剂型待定（降权，不丢弃）');
  return { excluded: false, gate: null, points, max: MODES[mode].max, tier: tierOf(points, mode), dims, notes, form: D1.form, phase: D3.phase };
}

module.exports = { score, dosageScore, physchemScore, phaseScore, gates, tierOf, MODES };

// ── 自检 ──
if (require.main === module) {
  const assert = require('assert');
  // 硬闸门：已知注射剂出局
  assert.equal(score({ drugName: '注射用某某单抗', drugClass: '单抗' }).excluded, true);
  assert.equal(score({ drugName: '某某原料药', regClass: '原料药' }).excluded, true);
  // 剂型待定不出局，只是 0 分
  const unknown = score({ drugName: '某分子 XX-101', onNitrosamineList: true });
  assert.equal(unknown.excluded, false);
  assert.equal(unknown.dims.D1, 0);
  assert.equal(unknown.dims.D2, 3);                       // 亚硝胺命中
  assert.equal(unknown.points, 6);
  assert.ok(unknown.notes.some(n => n.includes('剂型待定')));
  // 颗粒 + 亚硝胺 + III 期 = 满分 15 → A
  const best = score({ drugName: '某某颗粒', onNitrosamineList: true, phase: 'III期' });
  assert.deepEqual([best.points, best.tier], [15, 'A']);
  // 片剂 + 亚硝胺 + I 期 = 6+6+1 = 13 → A（lite 阈值 11）
  assert.equal(score({ drugName: '某某片', onNitrosamineList: true, phase: 'I期' }).tier, 'A');
  // 片剂 + 无亚硝胺 + 无期次 = 4+2+0 = 6 → C
  assert.equal(score({ drugName: '某某片' }).tier, 'C');
  // 滴眼液出局
  assert.equal(score({ drugName: '某某滴眼液', onNitrosamineList: true }).excluded, true);
  // full 模式：大客户加权 + 各维求和
  const big = score({ drugName: '某胶囊', company: '江苏恒瑞医药股份有限公司', regNo: 'CXHL2600001', phase: 'II期' }, { mode: 'full' });
  assert.equal(big.dims.D4, 3, '恒瑞应命中大客户');
  assert.equal(big.dims.D6, 3, '中文+法人后缀=中国主体');
  assert.equal(big.points, 2 * big.dims.D1 + 2 * big.dims.D2 + big.dims.D3 + 2 * big.dims.D4 + big.dims.D5 + big.dims.D6 + big.dims.D7);
  const small = score({ drugName: '某胶囊', company: '某某生物科技有限公司', regNo: 'CXHL2600002', phase: 'II期' }, { mode: 'full' });
  assert.equal(small.dims.D4, 1, '未命中大客户清单 → 1 分');
  assert.ok(big.points > small.points, '大客户应高于同等小公司');
  assert.equal(score({ drugName: '某片', company: '某某大学', regNo: 'CXHL2600003' }, { mode: 'full' }).dims.D4, 0, '高校 → 0 分');
  console.log('✅ scoring 自检通过（lite 6 组 + full 6 组断言）');
}