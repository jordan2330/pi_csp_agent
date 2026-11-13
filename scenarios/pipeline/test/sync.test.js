const test = require('node:test');
const assert = require('node:assert');
const { dedupe } = require('../sync');

// 同资产异写：历史遗留的「规范化键」与「原始键」并存 → 必须合成一行，否则表里长出重复行
const row = (o) => ({
  company: '江苏恒瑞医药股份有限公司', drugName: 'HRS-6093片', regClass: '1',
  regNo: 'CXHL2601396', last_seen: '2026-11-11', first_seen: '2026-11-11', ...o
});

test('dedupe：同资产两条合成一行，日期取晚、first_seen 取早', () => {
  const out = dedupe({
    '江苏恒瑞医药|HRS6093片': row({ regNo: 'CXHL2600582', first_seen: '2026-09-01', last_seen: '2026-09-01', phase: 'III期/NDA' }),
    '江苏恒瑞医药股份有限公司|HRS-6093片': row({})
  });
  assert.deepStrictEqual(Object.keys(out), ['江苏恒瑞医药股份有限公司|HRS-6093片']);   // 键 = 原始 公司|药名
  const r = out['江苏恒瑞医药股份有限公司|HRS-6093片'];
  assert.strictEqual(r.last_seen, '2026-11-11');
  assert.strictEqual(r.first_seen, '2026-09-01');
  assert.deepStrictEqual(r.reg_nos, ['CXHL2600582', 'CXHL2601396']);
  assert.strictEqual(r.phase, 'III期/NDA');   // 空期次不覆盖已有期次
});

test('dedupe：互不相同的资产不合并', () => {
  const out = dedupe({ a: row({ drugName: 'HRS-6093片' }), b: row({ drugName: 'HRS-7535片' }) });
  assert.strictEqual(Object.keys(out).length, 2);
});