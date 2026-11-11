#!/usr/bin/env node
/**
 * 管线/交易场景 —— 资格评分卡（纯函数，无 I/O）
 *
 * 依据：research/pipeline-business-fit.md §6（7 维 × 0-3 分，满分 27）+ §6.2 三道硬闸门
 * 设计要点：
 *   - 只有「有证据表明不匹配」才出局（G1/G3）；**剂型未知不丢弃**，只计 0 分
 *   - 分档阈值随「可计算的维度」缩放：lite = D1+D2+D3（满分 15），full = 27
 *   - D4-D7 需要企业属性/融资/决策权数据，本版返回 null（不猜、不计入分母）
 *
 * 自检：node scenarios/pipeline/scoring.js   （跑内置 assert）
 */

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

// ── 闸门 ──
function gates({ drugName = '', regClass = '', drugClass = '' }) {
  if (G1_FORM.test(drugName) || G1_CLASS.test(drugClass)) return { excluded: true, gate: 'G1-形态不符（CSP 无产品线）' };
  if (/原料药|中间体/.test(regClass)) return { excluded: true, gate: 'G3-原料药' };
  return { excluded: false, gate: null };
}

// ── 分档（阈值随可算维度缩放）──
const MODES = {
  lite: { dims: ['D1', 'D2', 'D3'], max: 15, tiers: [[11, 'A'], [8, 'B'], [5, 'C']] },
  full: { dims: ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'], max: 27, tiers: [[20, 'A'], [14, 'B'], [9, 'C']] }
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
  let points = 2 * D1.score + 2 * D2.score + D3.score;

  if (mode === 'full') {
    for (const k of ['d4', 'd5', 'd6', 'd7']) {
      const v = row[k];
      if (typeof v === 'number') { dims[k.toUpperCase()] = v; points += v; }
    }
  }
  const notes = [...D2.reasons];
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
  console.log('✅ scoring 自检通过（6 组断言）');
}