'use strict';
/** RSS 抓取与解析（零依赖）：公众号（wechat2RSS）+ Google News */

const { htmlToText, stripWechatHeader } = require('./text');

const UA = { 'user-agent': 'pi-csp-agent/1.0 (internal sales-lead research)' };

function pick(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

function parseItems(xml) {
  return String(xml || '').split(/<item[\s>]/i).slice(1).map(seg => `<item>${seg}`)
    .map(seg => {
      const raw = pick(seg, 'content:encoded') || pick(seg, 'description');
      const text = stripWechatHeader(htmlToText(raw));
      const title = htmlToText(pick(seg, 'title'));
      const pub = pick(seg, 'pubDate') || pick(seg, 'dc:date');
      const t = Date.parse(pub);
      return {
        title,
        text,
        url: pick(seg, 'link') || pick(seg, 'guid'),
        published: Number.isFinite(t) ? new Date(t).toISOString() : null
      };
    })
    .filter(it => it.title);
}

async function fetchFeed(url, { timeoutMs = 25000 } = {}) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseItems(await res.text());
}

async function fetchWechat(cfg, log = () => {}) {
  const out = [];
  for (const [name, id] of Object.entries(cfg.feeds)) {
    try {
      const items = (await fetchFeed(`${cfg.rss_base}/${id}.xml`)).slice(0, cfg.limits?.max_per_feed || 20);
      out.push(...items.map(it => ({ ...it, source: name })));
      log(`  ${name}: ${items.length} 条`);
    } catch (e) {
      log(`  ⚠️ ${name}: ${e.message}（跳过）`);
    }
  }
  return out;
}

async function fetchGoogleNews(cfg, log = () => {}) {
  const out = [];
  for (const g of cfg.google_news || []) {
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(g.q)}&hl=${g.hl}`;
      const items = await fetchFeed(url);
      // Google News 的 title 尾部带「 - 媒体名」，link 是跳转链接
      out.push(...items.map(it => ({ ...it, source: it.title.split(' - ').pop(), google: true, titleOnly: !it.text })));
      log(`  G:${g.q.slice(0, 16)}: ${items.length} 条`);
    } catch (e) {
      log(`  ⚠️ G:${g.q.slice(0, 16)}: ${e.message}（跳过）`);
    }
  }
  return out;
}

module.exports = { parseItems, fetchFeed, fetchWechat, fetchGoogleNews };