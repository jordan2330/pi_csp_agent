#!/usr/bin/env node
'use strict';
/**
 * sheet.js 回归测试（只测行模型纯函数：rowValues / checkRows，不发任何网络请求）
 * 跑：node --test scenarios/pipeline/test/
 */
const test = require('node:test');
const assert = require('node:assert');
const { SCHEMA, rowValues, checkRows } = require('../sheet');

// 与 scoring 锚点同源的一行（HRS-7058胶囊，26 分 A 档）
const ROW = {
  key: 'PIPE|山东盛迪医药有限公司|HRS-7058胶囊',
  tier: 'A', points: 26,
  company: '山东盛迪医药有限公司', drugName: 'HRS-7058胶囊',
  form: '胶囊（含胶囊型吸入）', phase: 'III期/NDA', regClass: '1',
  dims: { D1: 3, D2: 1, D3: 3, D4: 3, D5: 3, D6: 3, D7: 3 },
  notes: ['普通速释制剂（无已知痛点）', 'D4=3(大客户集团命中「恒瑞」)'],
  last_seen: '2026-05-18', first_seen: '2026-11-02',
  regNo: 'CXHL2600580', nct: 'NCT06915142'
};
const field = (title) => SCHEMA.find(f => f.field_title === title);

test('rowValues：总分/各维分是裸数字，不是数组（数组会被企微数字列丢弃）', () => {
  const v = rowValues(ROW);
  assert.equal(field('总分').field_type, 'FIELD_TYPE_NUMBER');
  assert.equal(v['总分'], 26);
  assert.equal(typeof v['总分'], 'number');
  assert.equal(Array.isArray(v['总分']), false);
  assert.deepEqual([v['D1剂型分'], v['D2理化分'], v['D3期次分']], [3, 1, 3]);
  // 空值不写 0，写空串（数字列 0 与「无数据」必须区分）
  assert.equal(rowValues({})['总分'], '');
});

test('rowValues：详情链接是 URL 值 + 字段声明带 property_url', () => {
  assert.equal(field('详情链接').field_type, 'FIELD_TYPE_URL');
  assert.deepEqual(field('详情链接').property_url, { type: 'LINK_TYPE_ICON_TEXT' }, 'URL 字段缺 property_url 会报 2022019');
  assert.deepEqual(rowValues(ROW)['详情链接'], [
    { type: 'url', text: 'NCT06915142', link: 'https://clinicaltrials.gov/study/NCT06915142' }
  ]);
  // 无 NCT 的 CDE-only 行：不写链接（不猜 URL）
  assert.deepEqual(rowValues({ ...ROW, nct: '' })['详情链接'], []);
});

test('rowValues：商机键形如 PIPE|公司|资产，档位落成单选文案', () => {
  const v = rowValues(ROW);
  assert.deepEqual(v['商机键'], [{ type: 'text', text: 'PIPE|山东盛迪医药有限公司|HRS-7058胶囊' }]);
  assert.match(v['商机键'][0].text, /^PIPE\|.+\|.+$/, '商机键必须 PIPE|公司|资产');
  assert.equal(v['档位'][0].text, 'A-本周跟');
  assert.equal(v['期次'][0].text, 'III期/NDA');
  assert.deepEqual([v['公司'][0].text, v['资产/药品名'][0].text], ['山东盛迪医药有限公司', 'HRS-7058胶囊']);
  // 日期值 = 毫秒时间戳字符串，回读为原日期
  assert.equal(new Date(Number(v['最近受理日'])).toISOString().slice(0, 10), '2026-05-18');
});

test('checkRows：权重与 scoring 一致，总分≠各维之和必须报错', () => {
  assert.deepEqual(checkRows([ROW]), [], '合规行不应报错');
  assert.deepEqual(checkRows([{ ...ROW, points: 25 }]),
    [['PIPE|山东盛迪医药有限公司|HRS-7058胶囊', '总分=25 与各维之和=26 不符']]);
  // 只改一维也必须被抓到（D4 ×2）
  assert.deepEqual(checkRows([{ ...ROW, dims: { ...ROW.dims, D4: 0 } }]),
    [['PIPE|山东盛迪医药有限公司|HRS-7058胶囊', '总分=26 与各维之和=20 不符']]);
});

test('checkRows：商机键格式 / 期次与 D3 矛盾都要报错', () => {
  assert.deepEqual(checkRows([{ ...ROW, key: 'HRS-7058胶囊' }]), [['HRS-7058胶囊', '商机键格式']]);
  assert.deepEqual(checkRows([{ ...ROW, key: '', phase: '', points: 0, dims: {} }]), [['', '商机键格式']]);
  assert.deepEqual(checkRows([{ ...ROW, phase: '' }]), [['PIPE|山东盛迪医药有限公司|HRS-7058胶囊', '无期次但 D3>0']]);
  assert.deepEqual(checkRows([{ ...ROW, dims: { ...ROW.dims, D3: 0 }, points: 23 }]),
    [['PIPE|山东盛迪医药有限公司|HRS-7058胶囊', '有期次(III期/NDA)但 D3=0']]);
});