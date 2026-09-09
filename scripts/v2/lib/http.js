/**
 * HTTP JSON 客户端 — 带重试退避（验收标准 #4）
 *  ≥2 次重试、429/5xx/超时/网络错误、递增退避 5s→15s→45s、30s 超时上限
 */
'use strict';
const https = require('https');
const http = require('http');

async function getJSON(url, { timeoutMs = 30000, retries = 3, backoff = [5000, 15000, 45000], log = () => {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const wait = backoff[Math.min(attempt - 1, backoff.length - 1)];
      log(`[http] ${url.slice(0, 90)} 第 ${attempt} 次重试 (${wait}ms)`);
      await new Promise(r => setTimeout(r, wait));
    }
    try {
      return await once(url, timeoutMs);
    } catch (e) {
      lastErr = e;
      if (!e.retryable) throw e;         // 非 429/5xx/超时/网络错误 → 不重试
      if (attempt === retries) throw e;   // 耗尽
    }
  }
  throw lastErr;
}

function once(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https:') ? https : http).get(url, {
      timeout: timeoutMs,
      headers: { Accept: 'application/json' }
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode === 429 || res.statusCode >= 500) {
          const e = new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`);
          e.retryable = true;
          reject(e);
          return;
        }
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      });
    });
    req.on('error', err => { err.retryable = true; reject(err); });
    req.on('timeout', () => {
      req.destroy();
      const e = new Error('Request timeout');
      e.retryable = true;
      reject(e);
    });
  });
}

module.exports = { getJSON };