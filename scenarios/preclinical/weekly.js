#!/usr/bin/env node
/**
 * 管线交易 —— 周任务入口（cron 只认这一条）
 *
 *   node scenarios/preclinical/weekly.js          # 抓取+抽取 → 同步子表 → 推周报
 *   node scenarios/preclinical/weekly.js --dry     # 只算不写（透传给 run/sync）
 *
 * 失败策略：
 *   抓取/抽取、同步失败 → 立即停止（没有新数据就没必要发周报）
 *   周报失败 → 只告警，不影响已经落库/落表的数据
 */

const { spawnSync } = require('child_process');
const path = require('path');

const NODE = process.execPath;                       // cron 里 PATH 没有 node，用当前解释器的绝对路径
const has = (f) => process.argv.includes(f);
const dry = has('--dry') ? ['--dry'] : [];

const steps = [
  { name: '抓取抽取', script: 'run.js', args: ['--since-hours', '192', ...dry], fatal: true },
  { name: '同步子表', script: 'sync.js', args: [...(has('--dry') ? ['--dry-run'] : [])], fatal: true },
  // --dry 时不让它推群：账本/表都没写，推出去的是过期内容
  { name: '周报推送', script: 'digest.js', args: [...(has('--dry') ? ['--no-send'] : [])], fatal: false }
];

(async () => {
  const results = [];
  for (const s of steps) {
    const t0 = Date.now();
    console.log(`\n═══ ${s.name} ═══`);
    const r = spawnSync(NODE, [path.join(__dirname, s.script), ...s.args], { cwd: path.resolve(__dirname, '..', '..'), stdio: 'inherit' });
    const sec = Math.round((Date.now() - t0) / 1000);
    results.push({ ...s, ok: r.status === 0, sec });
    if (r.status !== 0) {
      const why = r.error ? r.error.message : `退出码 ${r.status}`;
      console.error(`⚠️ ${s.name} 失败（${why}，${sec}s）`);
      if (s.fatal) break;                            // 后面的步骤依赖它，停
    }
  }

  console.log('\n── 本周任务小结 ──');
  for (const r of results) console.log(` ${r.ok ? '✅' : '❌'} ${r.name.padEnd(6)} ${String(r.sec).padStart(4)}s`);
  const hardFail = results.some(r => r.fatal && !r.ok);
  if (hardFail) { console.error('\n❌ 关键步骤失败，见上方日志'); process.exit(1); }
  if (results.some(r => !r.ok)) console.log('\n⚠️ 非关键步骤失败（数据已落库/落表，仅推送未完成）');
  else console.log('\n✅ 全部完成');
})();