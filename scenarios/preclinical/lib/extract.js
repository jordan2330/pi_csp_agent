'use strict';
/**
 * LLM 抽取：新闻正文 → 结构化事件（只抽取，不判断）
 *
 * 关键约束（防幻觉）：模型必须给出 evidence_quote（原文逐字片段），代码回文校验；
 * 对不上 → 整条标 needs_review，绝不静默入库。
 */


const SYSTEM = `你是医药行业信息抽取器。只抽取文中明确写出的信息，不推断、不补全。
只输出一个 JSON 对象，不要 markdown 代码块，不要解释。

字段：
- is_event: 布尔，本文是否在讲某个公司/资产的管线交易、融资、里程碑或合作
- type: license_out | license_in | financing | milestone | partnership | other
  （license_out=中国公司把权益授出；license_in=中国公司引进境外品种；financing=融资/IPO；
    milestone=研发/临床里程碑；partnership=合作但不涉授权）
- company_cn: **中国的**公司名（原文写法）。这是本表的行主角，必须是注册地/主体在中国的企业（含港股/美股上市的中国 biotech，如信达生物、百济神州、荣昌生物）
- counterparty_raw: 交易对方（通常是 MNC 或境外公司，如默沙东、诺华、Ollin）；无则空
- asset_raw: 涉及的药品/资产名或代号（无则空字符串）
- dosage_form_raw: 剂型或给药形式，原文写法（片/胶囊/注射液/冻干粉针/吸入粉雾剂/鼻喷雾剂/口服溶液/缓释片/预灌封/皮下注射等）；文中没写就空字符串，**不要猜**
- phase_raw: 文中提到的阶段原文（如「临床前」「I期」「IND」；无则空）
- amount_upfront_raw: 首付款/近期付款的原文金额（无则空）
- amount_total_raw: 交易总额的原文金额（无则空）
- amount_upfront_usd_m: 首付款折成「百万美元」的数字（如 3000万美元=30；没写则 null）
- amount_total_usd_m: 总额折成「百万美元」的数字（没写则 null）
- territory_raw: 授权范围的原文表述（无则空）
- territory_scope: 枚举 global | ex_greater_china | greater_china | regional | unknown
- china_rights: 枚举 retained（中国/大中华区权益保留给中方）| excluded（一并授出）| unknown
- counterparty_type: 枚举 MNC | 中国药企 | 投资机构 | NewCo | CDMO | 其他
- therapeutic_area: 枚举 肿瘤 | 自免/炎症 | 代谢/减重 | CNS | 呼吸 | 感染/疫苗 | 心血管/肾病 | 眼科 | 其他 | 未知
- one_liner: ≤30 字的一句话摘要（谁把什么阶段的什么资产授权给谁、多少钱）
- event_date: 文中事件日期 YYYY-MM-DD（无则用文章日期）
- evidence_quote: 从【正文】中原样复制的一段话（20–80 字），必须是判断该事件的依据
- confidence: 0-1，你对 is_event 与字段的把握

判定规则（重要）：
1. **必须是中国公司在做交易**（授出/引进/融资/里程碑/合作）。若通篇只是 MNC 在中国的采购、或中国公司只是被顺带提及，则 is_event=false。
2. **综述/盘点/周报/会议报道/书评/评论**（标题含「一周药闻」「盘点」「汇总」「大会」「解读」「好书推荐」「为什么」「怎么看」等）一律 is_event=false。
3. company_cn 与 counterparty_raw 要分开，不要把两个公司塞进 company_raw。
4. 金额用原文写法（「近27亿元」「3000万美元」「最高3亿美元」），不要换算。
5. 临床前数据读出、会议报告（如 AACR/ObesityWeek 公布临床前数据）算 milestone，属于早期信号。
6. evidence_quote 必须与【正文】**用同样的汉字**（繁体正文就引繁体），不要改写或翻译。
6.1 金额数字只能由原文换算，原文没写金额就填 null，**禁止估算**；金额原文必须能在正文里找到。
6.2 china_rights 只有原文明确写了才填 retained/excluded，看不出来一律 unknown——**这是最重要的禁止推断项**。
7. 若 is_event=false，其余字段可为空字符串。`;

function parseJson(s) {
  const t = String(s || '').replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i < 0 || j <= i) throw new Error('返回里没有 JSON');
  return JSON.parse(t.slice(i, j + 1));
}

const hardNorm = (s) => String(s || '').replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '');   // 去标点/空白/全半角
const normForCheck = (s) => hardNorm(s).toLowerCase();
/** 引文回文校验：严格子串 → 退化为 4-gram 重叠率（PDF 提取/繁简差异常导致严格失败） */
function quoteOk(quote, text) {
  const q = hardNorm(quote);
  if (q.length < 8) return false;
  const t = hardNorm(text);
  if (t.includes(q)) return true;
  const grams = new Set();
  for (let i = 0; i + 4 <= t.length; i++) grams.add(t.slice(i, i + 4));
  let hit = 0, total = 0;
  for (let i = 0; i + 4 <= q.length; i++) { total++; if (grams.has(q.slice(i, i + 4))) hit++; }
  return total > 0 && hit / total >= 0.7;
}

async function extractOne(item, cfg) {
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
        max_tokens: 700,
        enable_thinking: false          // 抽取不需要思维链：省 token，且避免 reasoning 吃掉输出预算
      }),
      signal: AbortSignal.timeout(60000)
    });
    const data = await res.json();
    if (data.error) throw new Error(`${data.error.code || 'llm'}: ${String(data.error.message || '').slice(0, 80)}`);
    return data.choices?.[0]?.message?.content || '';
  };

  const raw = await call(cfg.llm.model);
  const ev = sanitize(parseJson(raw), body);
  // 校验对象必须与喂给模型的一致（PDF 抓不到正文时喂的是标题，就要对标题校验）
  const ok = ev.is_event && quoteOk(ev.evidence_quote, body);
  return {
    ...ev,
    ok: !!ok,
    needs_review: !ok,
    review_why: ev.is_event && !ok ? '引文对不上原文' : (!ev.is_event ? '非事件' : ''),
    sources: [{ title: item.title, url: item.url, source: item.source, also: item.also || [], published: item.published }],
    extracted_by: `${cfg.llm.model}@${new Date().toISOString().slice(0, 10)}`
  };
}

const ENUM = {
  territory_scope: ['global', 'ex_greater_china', 'greater_china', 'regional', 'unknown'],
  china_rights: ['retained', 'excluded', 'unknown'],
  counterparty_type: ['MNC', '中国药企', '投资机构', 'NewCo', 'CDMO', '其他'],
  therapeutic_area: ['肿瘤', '自免/炎症', '代谢/减重', 'CNS', '呼吸', '感染/疫苗', '心血管/肾病', '眼科', '其他', '未知']
};
const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 200000 ? n : null;    // 百万美元上限 2000 亿，防「3 亿」被写成 300000000
};

/** 枚举白名单 + 金额合理性 + 原文可回查（金额/摘要都必须能在正文里找到出处） */
function sanitize(ev, body) {
  for (const [k, list] of Object.entries(ENUM)) {
    if (!list.includes(ev[k])) ev[k] = k === 'territory_scope' || k === 'china_rights' ? 'unknown' : (k === 'therapeutic_area' ? '未知' : '其他');
  }
  ev.amount_upfront_usd_m = money(ev.amount_upfront_usd_m);
  ev.amount_total_usd_m = money(ev.amount_total_usd_m);
  const txt = normForCheck(body);
  for (const k of ['amount_upfront', 'amount_total']) {
    const raw = `${k}_raw`;
    if (ev[raw] && !txt.includes(normForCheck(ev[raw]))) {          // 原文里找不到这个金额 → 视为编造，连数字一起清掉
      ev[raw] = '';
      ev[`${k}_usd_m`] = null;
    }
  }
  if (ev.territory_raw && !txt.includes(normForCheck(ev.territory_raw))) ev.territory_raw = '';
  return ev;
}

module.exports = { extractOne, quoteOk, parseJson, sanitize, money, SYSTEM };