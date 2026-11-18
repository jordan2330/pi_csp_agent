#!/usr/bin/env node
/**
 * 临床前信号 —— 交付层 CLI（把 events-<年>.json 投影到「临床前信号」子表）
 *
 * 用法：
 *   node scenarios/preclinical/sync.js --init      # 首次：把默认列改成 14 列 SCHEMA
 *   node scenarios/preclinical/sync.js --dry-run   # 只看会写多少行
 *   node scenarios/preclinical/sync.js             # 同步最近 60 天事件
 *   node scenarios/preclinical/sync.js --days 120
 *
 * 表 = 窗口内事件 ∪ 有销售反馈的行；数据列 pipeline 独占写，后 4 列销售手填。
 */

const path = require('path');
const WS = path.resolve(__dirname, '..', '..');
process.env.WECOM_TABLE = 'preclinical';        // cfg 分轴：config/wecom-preclinical[.env].json
require(path.join(WS, 'scripts', 'lib', 'wecom.js')).loadEnv();
const sheet = require('./sheet');
const events = require('./lib/events');

const has = (f) => process.argv.includes(f);
const arg = (n, d) => { const i = process.argv.indexOf(n); return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d; };

(async () => {
  const year = new Date().getFullYear();
  // 跨年不能只读当年：1 月 1 日新账本为空会把子表清空
  const rows = [...Object.values(events.load(year - 1).events), ...Object.values(events.load(year).events)];
  console.log(`账本 events-${year - 1}+${year}: ${rows.length} 条`);
  if (has('--init')) await sheet.initTable();
  const r = await sheet.sync(rows, { dryRun: has('--dry-run'), windowDays: arg('--days', 60) });
  console.log(JSON.stringify(r));
})().catch(e => { console.error('❌', e.message); process.exit(1); });
