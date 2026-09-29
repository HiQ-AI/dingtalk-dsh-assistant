# 第六轮：真实入站验收阻塞定位

已恢复派发：maintenance active=false/phase=inactive/revision=114；真实模型模式real。用户授权专用群，发验收任务一次，固定幂等键task-unified-live-20260929-01，DWS状态SUCCESS；独立messages-mget foundCount=1/complete=true，源内容含唯一验收标识。真实消息已进入工作流，S成功拆为一个事项，R多候选页判断独立新事项完成，但业务任务尚未派发。

只读执行与当前 `message.routing.pending` 完全一致的SQL，仅找到一个阻塞者：此前收信验证消息，status=settled、routingStatus=routing_complete、intentStatus=processed、units=[]；S成功保存kind=no_action，reason为模型自然文本。当前SQL只排除settled且reason=message_quiet，故错误地把合法终态no_action计为未归类，后续话题停在WAIT_ROUTING。业务busy全部0不代表任务已经完成。

这是当前实际渠道路径的既有查询漏洞，不是任务文件迁移损坏。补回归需先FAIL复现，然后最小查询修复及反例，重新受控安装后续跑同一原消息。不得手改旧消息、重发验收请求或绕屏障强建任务。真实业务验收本轮记FAIL，不能用已安装/HTTP200替代。

回归先证伪：旧查询下新增两个子用例均FAIL；最小SQL修复后定向7/7通过，message-workflow + message-ledger 完整定向122/122通过，0skip，退出0。未归类消息仍阻断后续派发；不改正式DB、状态或schema。
