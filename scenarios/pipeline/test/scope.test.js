#!/usr/bin/env node
'use strict';
/**
 * scope.js 回归测试（纯函数，只读 config/，不碰账本也不写盘）
 * 跑：node --test scenarios/pipeline/test/
 */
const test = require('node:test');
const assert = require('node:assert');
const { inScope, normalize, companyKey, loadAliases } = require('../scope');

const base = { drugType: '化药', applyType: '新药', regClass: '1类', company: '江苏恒瑞医药股份有限公司' };

test('inScope：只有 1 类创新药进队列（2.x 改良型新药已收掉）', () => {
  assert.equal(inScope(base), true, '1类');
  assert.equal(inScope({ ...base, regClass: '1' }), true, '1（无“类”后缀）');
  // 2026-11-11 口径再收：销售要求只留新药研发 pipeline（2.x 多为老药改剂型）
  // config/pipeline-scope.json: reg_class=["1"]；要加回 2.2 改成 ["1","2.2"]
  assert.equal(inScope({ ...base, regClass: '2.4' }), false, '2.4 新适应症不进');
  assert.equal(inScope({ ...base, regClass: '2.2类' }), false, '2.2 新剂型不进（可配置加回）');
});

test('inScope：中药 / 3类 / 补充申请 / 进口 / 占位公司名 / 5.x 全出局', () => {
  // config/pipeline-scope.json: drug_type=化药, exclude_import=true
  assert.equal(inScope({ ...base, drugType: '中药', regClass: '1.1类' }), false, '中药砍掉');
  assert.equal(inScope({ ...base, regClass: '3类' }), false, '3 类仿制不进');
  assert.equal(inScope({ ...base, applyType: '补充申请' }), false, '补充申请是事件不是新资产');
  assert.equal(inScope({ ...base, applyType: '进口', company: 'X Pharma', regNo: 'JXHL2600001' }), false, 'J 开头进口受理号 = 境外主体');
  assert.equal(inScope({ ...base, company: '不适用' }), false, '占位公司名不进');
  assert.equal(inScope({ ...base, regClass: '5.2类' }), false, '5.x 已上市进口不进');
  // 口径：apply_type=["新药"]，进口申请整类不进
  assert.equal(inScope({ ...base, applyType: '进口', regNo: 'CXHL2600001' }), false, '进口申请类型不进');
});

test('companyKey 保守：法人后缀不同视为同一主体，跨公司不合并', () => {
  assert.equal(normalize('江苏恒瑞医药股份有限公司'), '江苏恒瑞医药');
  assert.equal(normalize('江苏恒瑞医药有限公司'), '江苏恒瑞医药');
  assert.equal(companyKey('江苏恒瑞医药股份有限公司'), companyKey('江苏恒瑞医药有限公司'), '仅法人后缀不同 → 同键');
  assert.notEqual(companyKey('江苏恒瑞医药股份有限公司'), companyKey('恒瑞医药'), '缩写不做模糊匹配，宁可多一行也不误并');
  assert.notEqual(normalize('江苏恒瑞医药股份有限公司'), normalize('江苏豪森药业集团有限公司'));
  assert.equal(normalize('江苏豪森药业集团有限公司'), '江苏豪森药业');
});

test('normalize：只剥 (中国)/(China) 括号，全半角与空白一并归一', () => {
  assert.equal(normalize('某某医药（中国）有限公司'), '某某医药');
  assert.equal(normalize('某某医药(China)有限公司'), '某某医药');
  assert.equal(normalize(' 某某医药（中国）有限公司 '), normalize('某某医药有限公司'), '空白/括号差异不应制造新键');
  assert.equal(normalize('ABC Pharma 有限公司'), 'ABCPHARMA', '拉丁字母去空格并大写');
  // 其余括号保留（常含分支/主体信息）
  assert.equal(normalize('某某医药（上海）有限公司'), '某某医药上海');
});

test('别名表为空时 companyKey 退化为机械归一', () => {
  const { aliases } = loadAliases();
  assert.deepEqual(Object.keys(aliases), [], `config/company-aliases.json 当前应无别名，实得 ${JSON.stringify(aliases)}`);
  assert.equal(companyKey('某某药业有限公司'), normalize('某某药业有限公司'));
});