'use strict';
/** 关键词预过滤 + 标题去重（纯代码，过滤掉 80% 噪声后再花钱调 LLM） */

const PUNCT = /[\s\u3000，。、；：？！“”‘’（）()《》【】\[\]—\-…·,.;:?!'"|/\\]+/g;

/** 标题归一：去媒体后缀、标点、空白 → 用于跨源去重 */
function normTitle(t) {
  return String(t || '').replace(/\s+[-–—]\s+[^-–—]{2,20}$/, '').replace(PUNCT, '').toLowerCase();
}
const normText = s => String(s || '').replace(/\s+/g, '');

// 必须是医药管线语境，否则「雾化器独家首发」「脑机接口融资」这类会被混进来
const PHARMA = /(新药|创新药|药物|药品|抗体|双抗|ADC|抑制剂|激动剂|疫苗|制剂|适应症|靶点|受体|激酶|CRO|CDMO|临床|IND|管线|PCC)/;
const NOT_PHARMA = /(脑机|营养|食品|饮料|化妆品|医美|家用.{0,6}器|雾化器|机器人|睡眠|空气净化)/;

/** 关键词命中数 + 强信号加权（金额/临床前/授权/融资） */
function score(item, keywords) {
  const head = `${item.title} ${String(item.text || '').slice(0, 600)}`;
  const hits = keywords.filter(k => head.includes(k));
  let s = hits.length;
  if (/临床前|PCC|候选化合物/.test(head)) s += 4;
  if (/(首付款|里程碑付款|里程碑金额)/.test(head)) s += 4;
  if (/(授权|许可|License|独家)/i.test(head)) s += 3;
  if (/(完成.{0,6}轮融资|超额认购|亿元融资|亿美元融资|IPO|Pre-IPO)/.test(head)) s += 3;
  if (/(\$|美元|亿美元|万元|亿元|百万|千万)/.test(head)) s += 1;
  return { score: s, hits };
}

/** 关键词过闸 + 跨源标题去重（同一稿被多家转载只留一条，sources 记在 tags 里） */
function candidates(items, keywords, { minScore = 4 } = {}) {
  const byTitle = new Map();
  for (const it of items) {
    const head = `${it.title} ${String(it.text || '').slice(0, 600)}`;
    if (!PHARMA.test(head)) continue;            // 非医药语境直接丢
    const { score: s0, hits } = score(it, keywords);
    const s = NOT_PHARMA.test(head) ? s0 - 6 : s0;   // 消费品/器械类降权
    if (s < minScore) continue;
    const k = normTitle(it.title);
    const prev = byTitle.get(k);
    if (prev) { prev.also = [...new Set([...(prev.also || []), it.source])]; continue; }
    byTitle.set(k, { ...it, hits, score: s, also: [] });
  }
  return [...byTitle.values()].sort((a, b) => b.score - a.score || String(b.published).localeCompare(String(a.published)));
}

module.exports = { normTitle, normText, score, candidates };