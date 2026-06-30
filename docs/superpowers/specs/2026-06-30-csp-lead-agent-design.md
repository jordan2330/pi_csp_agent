# CSP 商机发掘 Agent 设计文档

> **日期:** 2026-06-30
> **状态:** 已批准，待写实现计划
> **技术栈:** TypeScript / Node.js / Pi Coding Agent / Playwright / Docker
> **LLM:** Qwen (通义千问) via DashScope/Bailian token plan，不使用 Anthropic

---

## 1. 目标

构建一个运行在 Docker 容器中的 Pi Agent，用于自动发掘 CSP（Aptar 活性包装）产品的销售商机。Agent 监控 FDA 公布的亚硝胺杂质风险 API 列表，逐一在中国药物临床试验登记与信息公示平台（chinadrugtrials.org.cn）搜索相关临床试验，匹配客户画像，生成包含 CSP 产品推荐的 Markdown 商机报告。

首个场景为**亚硝胺**，架构需支持未来扩展益生菌包装、体外诊断（IVD）等其他发掘场景。

## 2. 用户画像与需求

| 维度 | 定义 |
|------|------|
| 目标客户 | 中国药企（仿制药/创新药），在使用 FDA 亚硝胺风险 API 列表中的活性成分开展临床试验 |
| 交付物 | Markdown 格式的完整商机报告 |
| 执行模式 | 交互式调试 + 每周自动定时运行（无人值守） |
| 增量检测 | 每次运行对比上次数据，标记新增临床试验和新增客户 |
| 扩展性 | 未来新增场景（益生菌、IVD），每个场景独立一个 Skill |

## 3. 项目结构

```
pi-csp-agent/
├── docker-compose.yml
├── Dockerfile
├── .env                              # DASHSCOPE_API_KEY=sk-...（不提交到git）
├── .env.example                      # DASHSCOPE_API_KEY=（模板，可提交）
├── AGENTS.md                          # Pi项目指令（Pi启动时自动加载）
├── .pi/
│   └── settings.json                  # Pi配置：skills/prompts路径映射
├── config/
│   ├── models.json                    # Qwen模型配置（DashScope OpenAI兼容端点）
│   └── fda_nitrosamines.json          # Agent自动刷新生成（首次为空）
├── skills/                            # 通用工具skill
│   └── browser_executor/
│       ├── SKILL.md                   # frontmatter: name + description
│       └── scripts/
│           └── browser.js             # Playwright封装（navigate/type/click/extract/screenshot/wait）
├── scenarios/                         # 每个业务场景一个独立skill
│   └── nitrosamine/
│       ├── SKILL.md                   # 场景专用指令：数据源、匹配规则、报告模板
│       └── references/
│           └── csp-recommendations.md # CSP产品推荐规则（按potency category）
├── prompts/
│   └── lead-scan.md                   # 入口prompt template：/lead-scan nitrosamine
└── output/
    ├── CSP_Leads_Report.md            # 最终交付物
    └── runs/                          # 每次运行的快照JSON（用于增量对比）
```

### Pi 配置映射

`.pi/settings.json` 将项目目录映射到 Pi 的 discovery 路径：

```json
{
  "skills": ["skills/", "scenarios/"],
  "prompts": ["prompts/"]
}
```

`config/models.json` 复制到 `~/.pi/agent/models.json`（Docker 中通过 volume 挂载到 `/root/.pi/agent/`），Pi 启动时自动加载 Qwen provider 配置。

## 4. Docker 容器化

基于 Pi 文档的 **Plain Docker** 模式，扩展加入 Playwright/Chromium 支持。

### Dockerfile

```dockerfile
FROM node:24-bookworm-slim

# Playwright 依赖：Chromium 运行所需的系统库 + 中文字体
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       bash ca-certificates git ripgrep \
       chromium fonts-wqy-zenhei \
  && rm -rf /var/lib/apt/lists/*

# 使用系统Chromium，跳过Playwright自带浏览器下载
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=true
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
# 让脚本能 resolve 全局安装的 playwright
ENV NODE_PATH=/usr/lib/node_modules

RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent
RUN npm install -g playwright

WORKDIR /workspace
ENTRYPOINT ["pi"]
```

### docker-compose.yml

```yaml
services:
  csp-agent:
    build: .
    environment:
      - DASHSCOPE_API_KEY=${DASHSCOPE_API_KEY}
    volumes:
      - .:/workspace                    # 项目文件（skills, prompts, output）
      - pi-agent-home:/root/.pi/agent   # Pi会话和设置持久化
    stdin_open: true
    tty: true

volumes:
  pi-agent-home:
```

### Qwen 模型配置（config/models.json）

Pi 原生支持 Qwen 的 DashScope API。通过 `models.json` 配置为 OpenAI 兼容自定义 provider：

```json
{
  "providers": {
    "qwen": {
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "api": "openai-completions",
      "apiKey": "$DASHSCOPE_API_KEY",
      "compat": {
        "thinkingFormat": "qwen"
      },
      "models": [
        {
          "id": "qwen-max",
          "name": "Qwen Max",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 32768,
          "maxTokens": 8192,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        },
        {
          "id": "qwen-plus",
          "name": "Qwen Plus",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 131072,
          "maxTokens": 8192,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

此文件放置于 `~/.pi/agent/models.json` 或通过 Pi settings 指定路径。Docker 中挂载到 `/root/.pi/agent/models.json`。

**关键点：**
- `api: "openai-completions"` — DashScope 提供 OpenAI 兼容端点
- `compat.thinkingFormat: "qwen"` — Pi 原生支持 DashScope 风格的 `enable_thinking` 参数
- `cost` 全设为 0 — token plan 按套餐计费，非按量计费
- 模型选择：`qwen-max` 用于复杂推理（报告生成、CSP推荐），`qwen-plus` 用于常规爬取指令

### 运行模式

| 模式 | 命令 | 用途 |
|------|------|------|
| 交互调试 | `docker compose run --rm csp-agent` | 进入 Pi TUI，手动 `/lead-scan nitrosamine` |
| 自动运行 | `docker compose run --rm csp-agent -p "/lead-scan nitrosamine"` | 无头执行，配合 cron 每周定时 |

自动运行的 cron 示例（宿主机 crontab）：

```bash
0 8 * * 1 cd /path/to/pi-csp-agent && docker compose run --rm csp-agent -p "/lead-scan nitrosamine"
```

## 5. browser_executor Skill（通用底座）

通用浏览器操作工具，让 Pi 可以在真实浏览器中输入和点击网页。所有场景共用。

### 结构

```
skills/browser_executor/
├── SKILL.md
└── scripts/
    └── browser.js
```

### SKILL.md 核心内容

- frontmatter: `name: browser-executor`, `description` 说明用于真实浏览器自动化操作
- 使用说明：如何通过 bash 调用 `browser.js` 的各个子命令

### browser.js 命令接口

```bash
# 导航
node browser.js navigate <url>

# 输入文本
node browser.js type <css-selector> <text>

# 点击元素
node browser.js click <css-selector>

# 等待元素出现
node browser.js wait <css-selector> [--timeout 30000]

# 提取数据（返回JSON）
node browser.js extract <css-selector> [--format json|text]

# 截图（调试用）
node browser.js screenshot <filename>
```

### 关键设计决策

- **Playwright 而非 Puppeteer**：更好的反检测能力和中文网页兼容性
- **每次调用是独立进程**：简单可靠，Pi 通过 bash 调用，无需维护长连接
- **持久化浏览器上下文**：每次调用结束后将 cookies/session 保存到临时目录（如 `/tmp/browser-state.json`），下次调用启动新浏览器时加载该状态，避免重复登录或验证码
- **内置重试和等待逻辑**：chinadrugtrials 可能有加载慢或反爬机制
- **中文字体支持**：Dockerfile 安装 `fonts-wqy-zenhei` 确保中文正常渲染

## 6. nitrosamine 场景 Skill

### 结构

```
scenarios/nitrosamine/
├── SKILL.md
└── references/
    └── csp-recommendations.md
```

### SKILL.md 包含的指令

场景专用流程指令，LLM 读取后自主执行三阶段 pipeline：

1. **FDA 数据采集与缓存**
   - 用 `browser_executor` 访问 FDA 页面 `https://www.fda.gov/regulatory-information/search-fda-guidance-documents/cder-nitrosamine-impurity-acceptable-intake-limits#predicted`
   - 解析 Table 1：提取每条记录的 `{nitrosamine_name, source_api, potency_category, ai_limit}`
   - 去重 source_api → 得到唯一 API 列表
   - 写入 `config/fda_nitrosamines.json`（覆盖上次缓存）

2. **中国临床试验搜索**
   - 对每个 API（英文名 + 中文名）在 chinadrugtrials.org.cn 搜索
   - 提取字段：申请人/申办者、试验状态、适应症、试验分期、主要研究者、试验机构、登记日期
   - 合并 FDA 数据：附加 potency category 和 ai_limit
   - 与 `output/runs/` 上次快照对比 → 标记新增

3. **报告生成**
   - 根据 `references/csp-recommendations.md` 规则按 potency category 推荐 CSP 方案
   - 估算包装需求（基于试验规模和分期）
   - 生成 `output/CSP_Leads_Report.md`
   - 保存本次快照到 `output/runs/YYYY-MM-DD.json`

### csp-recommendations.md 推荐规则

| FDA Potency Category | 风险等级 | 推荐 CSP 方案 | 理由 |
|---------------------|---------|-------------|------|
| Cat 1 (26.5 ng/day) | 极高 | Activ-Blister® | 单格独立微气候控制，FDA已批准用于高风险口服固体 |
| Cat 2 (100 ng/day) | 高 | Activ-Blister® | 同上，每格同步控制湿度和氧气 |
| Cat 3 (400 ng/day) | 中高 | 3-Phase Activ-Polymer™ | 双功能活性层，兼容现有工艺 |
| Cat 4 (1500 ng/day) | 中 | 3-Phase Activ-Polymer™ 或 Activ-Vial® | 按包装形态选择 |
| Cat 5 (1500 ng/day) | 低 | Activ-Vial® / Activ-Film® | 瓶装选 Vial，柔性包装选 Film |

### 增量检测逻辑

- 每次运行后将完整结果保存为 `output/runs/YYYY-MM-DD.json`
- 下次运行时读取最近一次快照，对比：
  - 新增 API（FDA 新列入的）
  - 新增临床试验（chinadrugtrials 新登记的）
  - 状态变化（如试验从"进行中"变为"已完成"）
- 报告中单独列出"新增商机"章节

## 7. prompts/lead-scan.md（入口 Prompt Template）

Pi prompt template，用 `/lead-scan nitrosamine` 调用。内容：

```markdown
---
description: 执行CSP商机发掘扫描
argument-hint: "<scenario>"
---
执行 $1 场景的商机发掘扫描。

1. 使用 /skill:$1 加载场景 skill，按其 SKILL.md 指令执行完整 pipeline
2. 如遇到网页加载失败或验证码，暂停并向用户说明情况（交互模式），或记录错误并继续下一个API（自动模式）
3. 完成后输出 output/CSP_Leads_Report.md 的路径
```

## 8. 输出报告格式

`output/CSP_Leads_Report.md` 结构：

```markdown
# CSP 商机发掘报告 — 亚硝胺
> 生成日期: YYYY-MM-DD | 数据来源: FDA (版本日期) + 中国药物临床试验登记与信息公示平台
> 本次新增: N 条 | 总计: M 条

## 概览
- FDA亚硝胺风险API: X个 → 中国有临床试验: Y个
- 新增（本次）: N个
- 高风险(Cat 1-2): A个 | 中风险(Cat 3-4): B个 | 低风险(Cat 5): C个

## 新增商机（本次）
### <API中文名> <API英文名> — K家企业
| 申请人 | 试验状态 | 适应症 | 试验分期 | 登记日期 | FDA风险等级 | 推荐CSP方案 |
|--------|---------|--------|---------|---------|------------|------------|
| ...    | ...      | ...    | ...     | ...     | Cat N      | ...        |

## 全量商机列表
### 极高风险 (Cat 1)
（表格同上）

### 高风险 (Cat 2)
...

### 中高风险 (Cat 3)
...

### 中风险 (Cat 4)
...

### 低风险 (Cat 5)
...
```

## 9. 扩展性设计

未来新增场景（益生菌包装、IVD 等）只需：

1. 在 `scenarios/` 下新建目录，如 `scenarios/probiotics/`
2. 编写该场景的 `SKILL.md`（定义数据源、匹配规则、报告模板）
3. 编写该场景的 `references/` 参考文档
4. 用 `/lead-scan probiotics` 调用

无需修改 `browser_executor` skill 或 `lead-scan.md` prompt template。通用底座和入口 prompt 保持不变。

## 10. 错误处理

| 场景 | 处理方式 |
|------|---------|
| FDA 页面无法访问 | 重试 3 次，仍失败则使用上次缓存的 `fda_nitrosamines.json` 并在报告中注明 |
| chinadrugtrials 搜索超时 | 单个 API 超时跳过，记录到错误日志，继续下一个 |
| 验证码出现 | 交互模式：暂停等待用户处理；自动模式：截图保存，跳过该 API |
| API 中文名无法确定 | LLM 根据英文名推断中文名，无法确定时用英文名搜索 |
| 浏览器崩溃 | `browser.js` 内置异常退出，Pi 重新调用即可恢复 |
