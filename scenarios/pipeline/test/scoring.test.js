#!/usr/bin/env node
'use strict';
/**
 * scoring.js 回归测试（纯函数，无 I/O）
 * 跑：node --test scenarios/pipeline/test/
 */
const test = require('node:test');
const assert = require('node:assert');
const { score, tierOf, MODES } = require('../scoring');

// 权重唯一口径：D1/D2/D4 各 ×2，其余 ×1 → 7 维满分 30
const WEIGHTS = { D1: 2, D2: 2, D3: 1, D4: 2, D5: 1, D6: 1, D7: 1 };
const weighted = (dims) => Object.entries(WEIGHTS).reduce((sum, [k, w]) => sum + w * (dims[k] ?? 0), 0);

// 真实样例锚点：output/history/pipeline-cde.json → "山东盛迪医药有限公司|HRS-7058胶囊"
const HRS7058 = {
  drugName: 'HRS-7058胶囊', company: '山东盛迪医药有限公司', regClass: '1',
  phase: 'III期', regNo: 'CXHL2600580', d7: 3
};

test('总分公式与权重一致：2×D1+2×D2+D3+2×D4+D5+D6+D7，满分 30', () => {
  assert.equal(Object.values(WEIGHTS).reduce((a, b) => a + b, 0) * 3, 30, '权重和 ×3 应为 30');
  assert.equal(MODES.full.max, 30);
  assert.equal(MODES.lite.max, 15);
  const r = score(HRS7058, { mode: 'full' });
  assert.equal(r.points, 26);
  assert.equal(r.points, weighted(r.dims), '总分应等于各维加权之和');
});

test('锚点：HRS-7058胶囊 / 山东盛迪 / III期 / 1 类 = 26 分 A 档', () => {
  const r = score(HRS7058, { mode: 'full' });
  assert.deepEqual(r.dims, { D1: 3, D2: 1, D3: 3, D4: 3, D5: 3, D6: 3, D7: 3 },
    '胶囊 3 + 普通速释 1 + III期 3 + 盛迪(恒瑞) 3 + 受理号 3 + 中国主体 3 + 企业域邮箱 3');
  assert.equal(r.points, 26, '2×3 + 2×1 + 3 + 2×3 + 3 + 3 + 3 = 26');
  assert.equal(r.tier, 'A');
  assert.equal(r.excluded, false);
  assert.equal(r.form, '胶囊（含胶囊型吸入）');
  assert.equal(r.phase, 'III期/NDA');
});

test('D1/D2 权重 ×2：胶囊比片剂高 2 分，亚硝胺命中比普通速释高 4 分', () => {
  assert.equal(score({ drugName: '某胶囊' }).points, 8);
  assert.equal(score({ drugName: '某片' }).points, 6);
  assert.equal(score({ drugName: '某片' }).points - score({ drugName: '某片', onNitrosamineList: true }).points, -4);
});

test('档位阈值 full：A≥20 / B≥16 / C≥12 / 其余 D', () => {
  for (const [points, tier] of [[30, 'A'], [20, 'A'], [19, 'B'], [16, 'B'], [15, 'C'], [12, 'C'], [11, 'D'], [0, 'D']]) {
    assert.equal(tierOf(points, 'full'), tier, `full ${points} 分应为 ${tier} 档`);
  }
});

test('档位阈值 lite：A≥11 / B≥8 / C≥5 / 其余 D（阈值随地算维度缩放）', () => {
  for (const [points, tier] of [[15, 'A'], [11, 'A'], [10, 'B'], [8, 'B'], [7, 'C'], [5, 'C'], [4, 'D']]) {
    assert.equal(tierOf(points, 'lite'), tier, `lite ${points} 分应为 ${tier} 档`);
  }
});

test('G1 形态闸门：注射/冻干/生物药 → excluded，不产生分值', () => {
  const rows = [
    { drugName: 'HRS-4642注射液' },
    { drugName: '某某冻干粉针' },
    { drugName: '某生物制品', drugClass: '单抗' }
  ];
  for (const row of rows) {
    const r = score(row, { mode: 'full' });
    assert.equal(r.excluded, true, `${JSON.stringify(row)} 应出局`);
    assert.match(r.gate, /^G1-/, '闸门标记应为 G1-');
    assert.deepEqual([r.points, r.tier, r.max, r.dims], [0, 'D', 30, {}], '出局行不应带分值');
  }
});

test('G3 闸门：原料药出局；剂型未知只降权不出局', () => {
  const g3 = score({ drugName: '某某原料药', regClass: '原料药' });
  assert.deepEqual([g3.excluded, g3.points], [true, 0]);
  assert.match(g3.gate, /^G3-/);

  const unknown = score({ drugName: '某分子 XX-101' });
  assert.equal(unknown.excluded, false);
  assert.deepEqual([unknown.dims.D1, unknown.form], [0, null]);
  assert.ok(unknown.notes.includes('剂型待定（降权，不丢弃）'), `notes 应含剂型待定: ${unknown.notes}`);
});

test('lite vs full：维度集/满分不同，同一行可跨档', () => {
  const lite = score(HRS7058);
  const full = score(HRS7058, { mode: 'full' });
  assert.deepEqual(Object.keys(lite.dims), ['D1', 'D2', 'D3'], 'lite 只算 D1-D3');
  assert.deepEqual(Object.keys(full.dims), ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7']);
  assert.deepEqual([lite.points, lite.max], [11, 15]);
  assert.deepEqual([full.points, full.max], [26, 30]);

  // 无企业/期次/联系证据的窄行：lite 6 分 = C；full 9 分（D4=1 D6=1 兜底）= D
  assert.deepEqual([score({ drugName: '某某片' }).points, score({ drugName: '某某片' }).tier], [6, 'C']);
  const narrowFull = score({ drugName: '某某片' }, { mode: 'full' });
  assert.deepEqual([narrowFull.points, narrowFull.tier], [9, 'D']);
});