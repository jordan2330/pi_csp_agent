# SKILL：管线交易信息（BD / 授权 / 融资 / 里程碑）

> **目录名 `scenarios/preclinical/` 是历史遗留**：最初只想抓"临床前"信号，后来业务确认**不区分临床前后**——只要中国公司的管线交易（含临床阶段、NDA 阶段）。对外名称统一为**「管线交易信息」**，落在「CSP管线商机」文档的第二张子表。

## 一句话定位

从公众号 + 上市公司公告 + 新闻聚合里抽取**中国公司的管线交易事件**，入本地事件账本，投影到企微子表供销售跟进。

与「临床阶段管线」（244 行，公司×资产，有 CDE 受理号 + 7 维评分）的分工：

| | 临床阶段管线 | 管线交易信息 |
|---|---|---|
| 一行 | 公司 × 资产 | **一次事件**（公司×资产×类型×日期） |
| 来源 | CDE 受理（法定、有受理号） | 新闻/公告（可能只有传闻） |
| 判据 | 7 维评分卡 | 无评分，人工判断 |
| 表 | 子表 1（20 列） | 子表 2（15 列） |

## 日常运行

```bash
node scenarios/preclinical/run.js --since-hours 168            # 每周：抓取 → 过滤 → 抽取 → 入账本
node scenarios/preclinical/run.js --limit 50 --dry --report output/preclinical/review.md   # 只看不写，出人工复核表
node scenarios/preclinical/run.js --no-llm                     # 只验证数据源（不需要 Key）
node scenarios/preclinical/sync.js                             # 账本 → 子表（窗口 60 天 ∪ 有反馈）
node scenarios/preclinical/sync.js --dry-run

# 换姿势
--source cninfo        只看 cninfo 公告
--min-score 6          提高关键词阈值（少而精）
--recheck              （仅 enrich 类脚本有）重查已抽过的
```

定时（建议每周一）：

```cron
17 7 * * 1 cd <repo> && node scenarios/preclinical/run.js --since-hours 192 && node scenarios/preclinical/sync.js
```

## 数据源

| 源 | 形态 | 说明 |
|---|---|---|
| 公众号（15 个，内网 wechat2RSS，`127.0.0.1:18002`） | 全文 HTML → 纯文本 | 每号只给最近 **20 条** → **这是周频的上限**，月频会漏 |
| cninfo 巨潮公告检索 | 标题 + PDF | 一手法定披露，覆盖沪/深/创/科创/**港股**（`pageColumn=HKZB`）；标题检索很粗，必须过行业过滤 |
| Google News RSS | 只有标题 | 只做线索发现；feed 内声明"仅个人非商业使用"，不长期囤 |

**不接**：HKEXnews（ToS 禁转载 + Akamai 封锁，且 cninfo 已覆盖港股）、CNIPA（瑞数 + 需登录）、医药魔方系（协议 2.4 条禁自动化）、ASCO/ESMO/AACR（403/SPA 空壳）、逐家爬 biotech 官网（WAF/空壳）。

## 处理链

```
① 抓取        lib/rss.js（公众号 + Google News） / lib/cninfo.js（公告，行业过滤）
② 过滤        lib/filter.js：时间窗 → 医药语境闸门（PHARMA/NOT_PHARMA）→ 关键词打分 → 标题归一去重
③ 抽正文      lib/pdf.js：cninfo 公告抓 PDF 前 6 页（pdfminer.six，Python 侧依赖）
④ 抽取        lib/extract.js：deepseek-v4.1-flash-1017（enable_thinking=false）
              输出 is_event/type/company_cn/counterparty/asset/剂型/阶段/金额/授权范围/引文
⑤ 校验        引文必须能回文（严格子串 → 4-gram 70% 兜底）；对不上 → needs_review，不入库
⑥ 入库        lib/events.js：键 EVT|公司|资产|类型|日期；±3 天 + 代号交集合并
⑦ 投影        sheet.js：窗口 60 天 ∪ 有反馈；缩表护栏（腰斩拒绝）
```

### 抽取的硬规则（写进 prompt，直接决定精确率）

1. **必须是中国公司做交易**（授出/引进/融资/里程碑/合作）。MNC 在中国的采购 → 非事件；MNC 只能当"对方"。
2. 综述/盘点/周报/书评/评论（标题含"一周药闻/盘点/汇总/大会/解读/好书推荐/为什么"）→ 非事件。
3. 临床前数据读出、会议报告 → 算 `milestone`（早期信号）。
4. 金额用原文写法，不换算。
5. **剂型只抽原文写明的**，没写就空（不猜）。展示时再从资产名/标题按词表兜底（`HSK47388片`→片剂、`SIM0725注射液`→注射液）。

## 子表 15 列

```
事件键 | 事件日期 | 类型 | 中国公司 | 对方 | 资产/代号 | 剂型 | 阶段 | 金额 | 摘要 | 来源   ← pipeline 独占写
是否已有客户 | 跟进状态 | 负责人 | 备注                                              ← 销售手填
```

- `类型`：授权出海 / 引进 / 融资 / 里程碑 / 合作
- `阶段`：临床前 / IND / I期 / II期 / III期 / NDA-上市（正则按 **III→II→I** 降序匹配，否则 `III期` 会被 `I期` 抢走）
- `是否已有客户`：**销售手填**，不自动比对现有商机表（销售认定的是真实客户，不等于表里的行）

## 关键约束（踩过的坑）

| 坑 | 现状 |
|---|---|
| 企微 API **不能重命名子表**（`update_sheet` 报 worksheet not exist） | 名字在界面手动改 |
| `add_fields` 是**前插**；一次删光字段报 `2000055` | 改列顺序 → 删字段分批（5 个/批，留主字段），再倒序添加；行由账本重建 |
| 单选写入必须用**服务端选项 id** | `loadOpts(getFields())` 后取 id，用文本会被 `2022013` 拒绝 |
| 跨年账本 | `sync.js` 载入**当年 + 去年**，否则 1 月 1 日会清空子表 |
| 公众号反爬 | 无法按 URL 回补历史正文（mp.weixin.qq.com 直连返回验证页）→ 剂型靠"LLM + 词表"两级 |
| 资产改名（IBI324→OLN324） | `lib/aliases.js` 从「A（B）」「A/B」自动学配对，存 `config/preclinical-asset-aliases.json` |
| 错并比漏并更贵 | 任一侧没抽到资产就不合并；无有效日期不合并 |

## 未做

- 销售反馈不回流账本（nitrosamine/pipeline 都有 `feedback*.json`，这里没有）——等销售真开始填再做
- 金额/剂型一旦写错改不回来（fill-forward-only），只能人工改表
- 月度视图：只能靠 cninfo（支持任意日期区间）；公众号受 20 条限制