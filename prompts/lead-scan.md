---
description: 执行CSP商机发掘扫描
argument-hint: "<scenario>"
---
执行 $1 场景的商机发掘扫描。

1. 使用 /skill:$1 加载场景 skill，按其 SKILL.md 指令执行完整 pipeline
2. 首先确保 browser-executor skill 已就绪（如未加载则先 /skill:browser-executor）
3. 按场景 SKILL.md 的三个阶段依次执行：
   - Phase 1: FDA 数据采集与缓存
   - Phase 2: 中国临床试验搜索
   - Phase 3: 报告生成
4. 如遇到网页加载失败或验证码：
   - 交互模式：暂停并向用户说明情况，等待指示
   - 自动模式（pi -p）：截图保存，记录错误，继续下一个API
5. 完成后输出 output/CSP_Leads_Report.md 的路径，并简要总结新增商机数量
