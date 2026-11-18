'use strict';
/**
 * cninfo（巨潮资讯）公告检索 —— 一手法定披露，覆盖沪/深/创/科创/港股（pageColumn=HKZB）
 *
 * 只查标题（isfulltext=false）：标题本身就是「公司：与 X 就临床前 Y 签署独家授权协议」，
 * 信息密度足够判定事件；金额在 PDF 正文里，需要时人工点开（PDF 解析见 SKILL 待办）。
 */

const UA = { 'user-agent': 'pi-csp-agent/1.0 (internal sales-lead research)' };
const BASE = 'http://www.cninfo.com.cn/new/fulltextSearch/full';
const PDF = 'https://static.cninfo.com.cn/';

const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

async function searchOne(keyword, { sdate, edate, page = 1 } = {}) {
  const url = `${BASE}?searchkey=${encodeURIComponent(keyword)}&sdate=${sdate}&edate=${edate}`
    + `&isfulltext=false&sortName=pubdate&sortType=desc&pageNum=${page}`;
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.announcements || []).map(a => ({
    title: strip(a.announcementTitle),
    text: '',                                    // 只有标题：正文在 PDF
    titleOnly: true,
    url: a.adjunctUrl ? PDF + a.adjunctUrl : '',
    published: a.announcementTime ? new Date(a.announcementTime).toISOString() : null,
    source: `cninfo:${a.secName || a.secCode || ''}`,
    id: a.announcementId,
    secCode: a.secCode,
    pageColumn: a.pageColumn
  }));
}

// 标题检索很粗（「授权」会命中电力公司的董事会授权管理规则）→ 必须用行业词过滤
const PHARMA_NAME = /(药|生物|医药|医疗|制药|生物制品|生物科技|基因|抗体|疫苗|诊断)/;

async function fetchCninfo(cfg, { hours = 168, pages = 2, log = () => {} } = {}) {
  const today = new Date();
  const sdate = new Date(today.getTime() - hours * 3600e3).toISOString().slice(0, 10);
  const edate = today.toISOString().slice(0, 10);
  const out = [];
  const seen = new Set();
  for (const kw of cfg.cninfo_queries || []) {
    let kept = 0;
    try {
      for (let page = 1; page <= pages; page++) {
        const items = await searchOne(kw, { sdate, edate, page });
        if (!items.length) break;
        for (const it of items) {
          if (seen.has(it.id)) continue;
          if (!PHARMA_NAME.test(`${it.source} ${it.title}`)) continue;   // 剔掉非医药公司
          seen.add(it.id);
          out.push(it); kept++;
        }
        await new Promise(r => setTimeout(r, 600));                       // 巨潮限流保守
      }
      log(`  cninfo「${kw}」: 保留 ${kept} 条（已滤非医药）`);
    } catch (e) {
      log(`  ⚠️ cninfo「${kw}」: ${e.message}（跳过）`);
    }
  }
  return out;
}

module.exports = { searchOne, fetchCninfo, strip };