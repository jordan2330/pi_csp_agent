'use strict';
/** HTML → 纯文本（公众号正文 20KB+ HTML，抽 3K 字给 LLM 足够） */

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ldquo: '“', rdquo: '”', mdash: '—', hellip: '…', middot: '·' };

function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h\d|li|tr)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');                                  // 正文里连文字都去掉了：img/svg 等无文本内容
  s = s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : ''; }
    return ENT[e.toLowerCase()] ?? m;
  });
  return s.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}

/** 公众号正文开头常有「公众号名 2026-11-17 16:41 上海 正文共：973字…」这类噪声 */
function stripWechatHeader(text) {
  return String(text || '')
    .replace(/^[\s\S]{0,80}?正文共[:：]\s*\d+\s*字[^\n]*\n?/, '')
    .replace(/^[\s\S]{0,40}?预计阅读时间[:：]?\s*\d+\s*分钟[^\n]*\n?/, '')
    .trim();
}

module.exports = { htmlToText, stripWechatHeader };