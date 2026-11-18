'use strict';
/**
 * LLM 抽取：新闻正文 → 结构化事件（只抽取，不判断）
 *
 * 关键约束（防幻觉）：模型必须给出 evidence_quote（原文逐字片段），代码回文校验；
 * 对不上 → 整条标 needs_review，绝不静默入库。
 */

const { normText } = require('./filter');

const SYSTEM = `你是医药行业信息抽取器。只抽取文中明确写出的信息，不推断、不补全。
只输出一个 JSON 对象，不要 markdown 代码块，不要解释。

字段：
- is_event: 布尔，本文是否在讲某个公司/资产的管线交易、融资、里程碑或合作
- type: license_out | license_in | financing | milestone | partnership | other
  （license_out=中国公司把权益授出；license_in=中国公司引进境外品种；financing=融资/IPO；
    milestone=研发/临床里程碑；partnership=合作但不涉授权）
- company_raw: 文中主角公司名（原文写法，最多两个用 / 分隔）
- asset_raw: 涉及的药品/资产名或代号（无则空字符串）
- phase_raw: 文中提到的阶段原文（如「临床前」「I期」「IND」；无则空）
- amount_upfront_raw: 首付款/近期付款的原文金额（无则空）
- amount_total_raw: 交易总额的原文金额（无则空）
- territory_raw: 授权范围的原文表述（无则空）
- event_date: 文中事件日期 YYYY-MM-DD（无则用文章日期）
- evidence_quote: 从【正文】中原样复制的一段话（20–80 字），必须是判断该事件的依据
- confidence: 0-1，你对 is_event 与字段的把握

若 is_event=false，其余字段可为空字符串。`;

function parseJson(s) {
  const t = String(s || '').replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i < 0 || j <= i) throw new Error('返回里没有 JSON');
  return JSON.parse(t.slice(i, j + 1));
}

/** 引文回文校验：忽略空白差异，quote 必须是正文的子串 */
function quoteOk(quote, text) {
  const q = normText(quote);
  return q.length >= 8 && normText(text).includes(q);
}

async function extractOne(item, cfg, { log = () => {}, retryModel = null } = {}) {
  const key = process.env.DASHSCOPE_API_KEY;
  if (!key) throw new Error('缺少 DASHSCOPE_API_KEY（写进 .env 或 export）');
  const body = String(item.text || '').slice(0, cfg.llm?.max_chars || 3000) || `（只有标题，无正文）${item.title}`;
  const user = `【文章】标题：${item.title}\n来源：${item.source}\n日期：${item.published || ''}\n\n【正文】\n${body}`;

  const call = async (model) => {
    const res = await fetch(`${cfg.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
        temperature: 0,
        max_tokens: 700
      }),
      signal: AbortSignal.timeout(60000)
    });
    const data = await res.json();
    if (data.error) throw new Error(`${data.error.code || 'llm'}: ${String(data.error.message || '').slice(0, 80)}`);
    return data.choices?.[0]?.message?.content || '';
  };

  let raw;
  try { raw = await call(cfg.llm.model); } catch (e) {
    if (!retryModel || retryModel === cfg.llm.model) throw e;
    log(`    重试(${retryModel}): ${e.message.slice(0, 50)}`);
    raw = await call(retryModel);
  }
  const ev = parseJson(raw);
  const ok = ev.is_event && quoteOk(ev.evidence_quote, item.text);
  return {
    ...ev,
    ok: !!ok,
    needs_review: !ok,
    review_why: ev.is_event && !ok ? '引文对不上原文' : (!ev.is_event ? '非事件' : ''),
    sources: [{ title: item.title, url: item.url, source: item.source, also: item.also || [], published: item.published }],
    extracted_by: `${cfg.llm.model}@${new Date().toISOString().slice(0, 10)}`
  };
}

module.exports = { extractOne, quoteOk, parseJson, SYSTEM };