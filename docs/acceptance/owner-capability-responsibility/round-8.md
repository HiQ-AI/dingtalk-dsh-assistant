# Round 8：注入中的完整索引

用户粘贴eventWatermark854的coordinator注入为14737字符，completionEvidenceRefs45项5536字符、workflowCatalog3502字符，两项约61%。最新只读现场注入17314字符、证据引用60项7381字符。

复用现有无损owner-context-section投影：这两类数组超过2048字符按需读，原始Host输入和授权、证据校验均不变。原需求和本轮事件直接保留。原日志不改写。

对用户原文及最新注入运行真实投影：14737→6190（减少58%）；17314→6922（减少60%）。两字段读取后内容逐字等价，goal/events未变。重现脚本docs/tmp/measure-owner-context-indexes.mjs；输入源为用户附件和原会话JSONL。7项上下文测试通过，原生会话相关回归另记。以上是离线真实输入投影测量，不代表已安装的新回合。
- 最终定向验证：上下文suite 7/7、原生会话suite 67/67 PASS。
