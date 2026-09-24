# 消息与任务运行入口集成验证

日期：2026-09-24。状态：进行中，尚未部署。

## 真实模型分析链

使用当前安装的 DSH 原生 LlmRuntime、AgentLoop、Session 持久化及 openai-codex 适配器；模型 gpt-6-sol，reasoningEffort=low。测试正文为自建“北京是中国首都”摘要材料，不读取业务附件、不发送渠道消息。

复跑命令：

```powershell
node --use-env-proxy docs/acceptance/runtime-redesign/scripts/probe-message-provider.mjs --profile <当前profile绝对路径> --output <本轮证据JSON路径> --pipeline
```

三次真实链路的结果分别保留，不能以第三次成功覆盖前两次失败：

1. `pipeline.json`：S 9.388 秒后被来源覆盖校验拒绝。模型漏掉最后一个字符，未创建 Task。修复为代码计算全文长度/片段边界，校验错误定向反馈；不自动补齐模型遗漏的覆盖。
2. `pipeline-2.json`：S/R/I 分别 3.823/4.279/2.731 秒，I 提供 goal/material 而缺少 objective，Task 未创建。修复为严格命名参数合同和按意图必需字段校验，禁止别名兜底。
3. `pipeline-3.json`：可靠接收 96 毫秒，S/R/I 分别 4.251/2.558/2.769 秒；完整分析任务 13.875 秒，MessageRun=settled、Task=succeeded，独立读取最终结果“北京是中国的首都。”。

这些是三个诊断样本，不能推断 p95、繁忙群吞吐或所有业务耗时。原始 JSON/SQLite/Session 留在本机，不批量提交。

## 隔离回归证据

- `node --test test/workflow-service.test.js`：8/8 PASS。覆盖真实同库接纳到 Task 结果、无权来源、未提供可信编辑版本、Web/IM 澄清首终态、纯话题约束继承、群集合查询、附件快照交接、通知未知状态不重发。
- 附件读取反例让第二次读取返回不同文本；代码只读一次并落持久快照，Task 输入仍为第一次已接纳内容。
- `node --test test/workflow-service.test.js test/workflow-recovery.test.js`：10/10 PASS。加入单任务恢复错误隔离，以及 201 条未知通知不饿死新通知的反例。
- 第一次全仓 `node --test` 出现一项失败：旧内存 Host 测试没有持久存储路径，新的 seal 准入拒绝。该结果保留在本机日志；待修正测试契约并全仓复跑，不能写全仓通过。

## 部署前现场对账

只读核查时有 68 个已完成 Task、1474 条已归类消息；5 条旧协调请求仍 pending，1 条接收回执发送超时。对应旧消息已处理，两个旧话题版本已追平，后续完成通知已有送达记录。指定时间窗的渠道搜索完整但未找到超时回执，不能因此标记送达。

用户已明确批准：保留快照和逐项证据，将 5 条旧协调请求按后续处理取代收口，终止 1 条过期接收回执补发。尚未执行停机、写入、切换或安装；执行后须另记精确摘要和读回证据。

## 未完成边界

- 同源编辑、运行中需求修订及其旧效果处理仍在最终集成复核。
- 真实工程模型链见 round-14.md；GitHub 和消息发送仍是隔离协议验证，不是实际外发验收。
- 当前准入材料分析与受管工程工作流；生产 SQL/Bytebase 的执行审批适配器未实现，不能声称全业务流程已支持。
- 本地部署、安装摘要、新 PID、浏览器实际状态及新入口在运行实例内的验收尚未完成。
