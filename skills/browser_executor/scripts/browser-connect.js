/**
 * 浏览器连接解析（真浏览器 CDP / 本地 launch 双态）
 *
 * 优先级：
 *   1. 环境变量 BROWSER_ENDPOINT（显式指定，http:// 或 ws:// 均可）—— 必须成功，失败即报错
 *   2. 默认 CDP 端点 http://127.0.0.1:9223
 *      → Windows 侧专用 profile Chrome（由 scripts/launch-chrome.sh 启动 / 自动拉起）
 *      → WSL 需要 mirrored 网络模式才能访问 Windows 的 127.0.0.1
 *   3. CDP_ALLOW_LOCAL_LAUNCH=1 时兜底 chromium.launch()（仅开发调试用；
 *      自带浏览器是自动化指纹，会被瑞数动态安全拦截，不要用于生产采集）
 *
 * 返回 { browser, isRealBrowser, endpoint }：
 *   isRealBrowser=true  → 用户真实浏览器：不要覆盖 UA / viewport / 注入伪造指纹
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_CDP_ENDPOINT = process.env.CDT_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const LAUNCHER = path.join(__dirname, '..', '..', '..', 'scripts', 'launch-chrome.sh');

// ── 尝试拉起 Windows Chrome（仅 WSL/Linux，可用 CDP_NO_AUTOLAUNCH=1 关闭）──
function maybeLaunchChrome() {
  if (process.env.CDP_NO_AUTOLAUNCH === '1') return false;
  if (process.platform !== 'linux' || !fs.existsSync(LAUNCHER)) return false;
  try {
    execFileSync('bash', [LAUNCHER], { stdio: 'inherit', timeout: 90000 });
    return true;
  } catch (e) {
    console.error(`[browser] 自动启动 Chrome 失败: ${e.message.substring(0, 120)}`);
    return false;
  }
}

/**
 * @param {object} opts
 * @param {string[]} opts.launchArgs  本地兜底 launch 的参数
 * @param {string} [opts.executablePath]  本地兜底 launch 的可执行文件（PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH）
 * @returns {Promise<{browser, isRealBrowser, endpoint}>}
 */
async function connectBrowser(opts = {}) {
  const { chromium } = require('playwright');
  const { launchArgs = [], executablePath } = opts;
  const endpoint = process.env.BROWSER_ENDPOINT || DEFAULT_CDP_ENDPOINT;

  const tryConnect = async (ep, timeout) => {
    const browser = await chromium.connectOverCDP(ep, { timeout });
    return { browser, isRealBrowser: true, endpoint: ep };
  };

  // 1/2. 先连现有端点
  try {
    return await tryConnect(endpoint, 15000);
  } catch (e) {
    if (process.env.BROWSER_ENDPOINT) throw e;  // 显式指定 → 不兜底，直接暴露问题

    // 默认端点：可能只是 Chrome 没开，尝试拉起后重试一次
    if (maybeLaunchChrome()) {
      try { return await tryConnect(endpoint, 20000); } catch (_) {}
    }

    console.error(`[browser] ❌ 连不上本机 Chrome: ${endpoint}`);
    console.error('[browser]    请先运行: bash scripts/launch-chrome.sh');
    console.error('[browser]    (需 Windows 侧 Chrome + WSL mirrored 网络模式)');

    if (process.env.CDP_ALLOW_LOCAL_LAUNCH !== '1') {
      throw new Error(`Chrome CDP 端点不可用: ${endpoint}`);
    }
    const browser = await chromium.launch({ headless: true, args: launchArgs, executablePath });
    return { browser, isRealBrowser: false, endpoint: '(local launch)' };
  }
}

module.exports = { connectBrowser, DEFAULT_CDP_ENDPOINT };