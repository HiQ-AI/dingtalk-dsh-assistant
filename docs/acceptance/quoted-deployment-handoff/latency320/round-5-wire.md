# 第五轮：原始工具参数丢失位置核验

## 结果

FAIL，无效调用2仍存在。实际`cortex-gateway/cortex-cowork`、low，同类#320图文承接，39041.777ms、7次标准stream（route4、decision3），同请求同query+offset的重复Task目录0；最终只捕获一项正确的新只读物料名称排查Task。

本轮在验收脚本的fetch侧观察实际请求工具schema和SSE工具参数，仅记录`tool_use`、`input_json_delta`，不记录headers、图片body、reasoning正文或密文。关键脱敏事实见`round-5-wire-summary.json`，完整工具wire在忽略目录`docs/tmp/quoted-deployment-handoff/latency320/model-round-5-wire/`。

## 因果边界

1. 实际HTTP请求的`group_topic_context_get.input_schema`为完整对象根，包含`properties.topicId`、`required:[topicId]`；排除前轮根oneOf适配丢字段的同因解释。
2. 第一个SSE响应已有两个同名`tool_use`，两者start.input均为`{}`，该响应没有`input_json_delta`。原生assistant消息也在同一step1并行记录两次空调用；不是两次收到拒绝后的持续循环。
3. 虽然当前pi-ai结束toolCall时重解析partialJson的实现存在值得单独注意的边界，此处start本来就是空对象，不支持“这些调用的有效参数被DSH后置覆盖”的解释。

可观察断点位于提供方SSE输出之前，无法从本机证据进一步区分网关内部或模型生成行为；不读取reasoning来推断隐藏意图。最终采用调用合同的可发现性修复：候选带完整readCall与已有摘要，真正需要历史才复制模板读取，不默认任意Topic、不补写模型参数、不加隐藏缓存。

真实TaskStore/Owner/渠道未接入，真实写入/发送0，官方凭据文件摘要未变。7个已捕获SSE响应不代表提供方内部请求或重试总数；费用未知。
