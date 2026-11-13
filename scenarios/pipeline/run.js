#!/usr/bin/env node
/**
 * 管线场景 —— 日常入口（一条命令：采 CDE → 补期次 → 补联系渠道 → 同步第二张表）
 *
 * 用法：
 *   node scenarios/pipeline/run.js                 # 日常（CDE 增量 + 富化 + 同步 A/B）
 *   node scenarios/pipeline/run.js --dry-run       # 同步只看不写
 *   node scenarios/pipeline/run.js --skip-collect  # 跳过 CDE（只富化+同步）
 *   node scenarios/pipeline/run.js --skip-enrich   # 跳过两处富化
 *   node scenarios/pipeline/run.js --no-sync       # 只更新账本，不碰表
 *   node scenarios/pipeline/run.js --tiers A       # 只同步 A 档
 *   透传：--from DATE / --start-page N / --max-pages N（采集），--recheck（富化重查）
 *
 * 失败策略：采集/富化失败 → 告警后继续（账本是增量的，失败=本轮没新增；同步幂等，空跑无害）；
 *          同步失败 → 整体退出 1（交付没落地，必须有人知道）。
 */

const { spawnSync } = require('child_process');
const path = require('path');

const WS = path.resolve(__dirname, '..', '..');
const has = (f) => process.argv.includes(f);
const val = (f) => { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : null; };
const log = (...a) => console.log(...a);

// 采集侧透传参数（只传用户显式给了的）
const collectArgs = ['--from', '--start-page', '--max-pages', '--lookback-days'].flatMap((f) => (val(f) ? [f, val(f)] : []));
const enrichArgs = has('--recheck') ? ['--recheck'] : [];
const syncArgs = [has('--dry-run') ? '--dry-run' : null, val('--tiers') ? `--tiers=${val('--tiers')}` : null].filter(Boolean);
// 无人值守也要有墙钟上限：单步卡住(CT.gov 限流、浏览器白屏)不能拖整晚
const STEP_TIMEOUT_MS = Number(process.env.PIPE_STEP_TIMEOUT_MIN || 30) * 60000;

const steps = [];
if (!has('--skip-collect')) steps.push({ name: 'CDE 采集', script: 'sources-cde.js', args: collectArgs, required: false });
if (!has('--skip-enrich')) {
  steps.push({ name: '期次富化', script: 'enrich-phase.js', args: enrichArgs, required: false });
  steps.push({ name: '期次(CDT)', script: 'enrich-phase-cdt.js', args: [...enrichArgs, '--limit', '40', '--max-details', '3'], required: false });
  steps.push({ name: '联系渠道', script: 'enrich-contact.js', args: enrichArgs, required: false });
}
if (!has('--no-sync')) steps.push({ name: '同步表', script: 'sync.js', args: syncArgs, required: true });

const results = [];
for (const s of steps) {
  log(`\n═══ ${s.name}（${s.script}） ═══`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, s.script), ...s.args], { cwd: WS, stdio: 'inherit', timeout: STEP_TIMEOUT_MS });
  const sec = Math.round((Date.now() - t0) / 1000);
  const ok = r.status === 0;
  results.push({ name: s.name, ok, sec, required: s.required });
  if (!ok) {
    const why = r.error?.code === 'ETIMEDOUT' ? `超时 ${STEP_TIMEOUT_MS / 60000} 分钟被终止` : (r.error?.message || `退出码 ${r.status}`);
    console.error(`⚠️ ${s.name} 失败（${why}，${sec}s）${s.required ? '' : ' —— 继续下一步'}`);
  }
}

const failed = results.filter((r) => !r.ok);
log('\n── 本轮小结 ──');
for (const r of results) log(` ${r.ok ? '✅' : '❌'} ${r.name.padEnd(8)} ${String(r.sec).padStart(5)}s`);
const hardFail = failed.some((r) => r.required);
if (hardFail) { console.error(`\n❌ 有 ${failed.length} 步失败（含关键步骤），见上方日志`); process.exit(1); }
if (failed.length) log(`\n⚠️ ${failed.length} 步失败但非关键（数据/表保持上一轮状态）`);
else log('\n✅ 全部完成');