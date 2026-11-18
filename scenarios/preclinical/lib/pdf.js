'use strict';
/**
 * cninfo 公告 PDF → 纯文本（pdfminer.six，Python 侧依赖，Node 仍零依赖）
 *
 * 为什么需要：公告标题里有公司/对方/事件，但**首付款与总额只在 PDF 正文**。
 * 只取前 N 页（默认 6 页）——金额几乎都在「交易概述」前两页。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PY = `
import sys
from pdfminer.high_level import extract_text
p, n = sys.argv[1], int(sys.argv[2])
print(extract_text(p, page_numbers=list(range(n)), maxpages=n) or "")
`;

async function pdfText(url, { maxPages = 6, timeoutMs = 60000 } = {}) {
  const res = await fetch(url, { headers: { 'user-agent': 'pi-csp-agent/1.0' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`PDF HTTP ${res.status}`);
  const tmp = path.join(os.tmpdir(), `cninfo-${process.pid}-${Date.now()}.pdf`);
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  try {
    const out = execFileSync('python3', ['-c', PY, tmp, String(maxPages)], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    return out.replace(/\n{3,}/g, '\n\n').replace(/[ \t\u00a0]+/g, ' ').trim();
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件删不掉不影响主流程 */ }
  }
}

module.exports = { pdfText };
