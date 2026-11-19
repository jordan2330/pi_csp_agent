#!/usr/bin/env node
/**
 * 临床前信号 —— 交付层 CLI（把 events-<年>.json 投影到「临床前信号」子表）
 *
 * 用法：
 *   node scenarios/preclinical/sync.js --bootstrap # 首次（生产）：在「CSP管线商机」文档下建子表并写配置
 *   node scenarios/preclinical/sync.js --init      # 首次：把默认列改成 SCHEMA（22 列）
 *   node scenarios/preclinical/sync.js --dry-run   # 只看会写多少行
 *   node scenarios/preclinical/sync.js             # 同步账本近 400 天（一年，含已补录历史）
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
  if (has('--bootstrap')) {
    const W = require(path.join(WS, 'scripts', 'lib', 'wecom.js'));
    if (sheet.readCfg().sheet_id) {
      console.log('子表配置已存在，跳过 bootstrap（要重建请先手动删配置）');
    } else {
      const prev = process.env.WECOM_TABLE;
      process.env.WECOM_TABLE = 'pipeline';
      const pcfg = W.readCfg();                       // 复用管线文档：两张子表必须在同一文档下
      process.env.WECOM_TABLE = prev;
      if (!pcfg.docid) {
        console.error('❌ 找不到「CSP管线商机」文档配置 —— 先跑：node scenarios/pipeline/sync.js --init');
        process.exit(1);
      }
      const r = await W.api('/wedoc/smartsheet/add_sheet', { docid: pcfg.docid, name: '管线交易信息' });
      const sid = r.properties?.sheet_id || r.sheet_id;
      if (!sid) throw new Error(`add_sheet 未返回 sheet_id: ${JSON.stringify(r).slice(0, 200)}`);
      W.writeCfg({ docid: pcfg.docid, sheet_id: sid, url: pcfg.url, official: true, created_at: new Date().toISOString() });
      console.log(`✅ 已在同一文档下建子表 sheet_id=${sid}`);
      console.log('   企微 API 不能重命名子表 → 请在界面把该标签改成「管线交易信息」');
    }
  }
  if (has('--init')) await sheet.initTable();
  const r = await sheet.sync(rows, { dryRun: has('--dry-run'), windowDays: arg('--days', 400) });
  console.log(JSON.stringify(r));
})().catch(e => { console.error('❌', e.message); process.exit(1); });
