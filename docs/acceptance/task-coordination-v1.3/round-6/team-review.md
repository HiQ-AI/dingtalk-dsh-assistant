# 原生队友独立审查

## 真实团队与边界
- 实际Agent调用显式sequence-worker/effort=low；ListAgents读回两名真实队友；原生team config backendType=in-process；lead未改变high。
- contract-worker只读协调依赖，evidence-worker只读设计与反证；只有lead外发，均限唯一授权测试群；未部署或修改插件。
- 原生会话记录保存在当前session/subagents；不把工具成功或角色列表当真实E2E。

## Contract-worker结论
- 安装9f41510与main5a1ab91六个ABC核心文件无差异；现包保留依赖合同。
- 三个new-task：A creationKey=A/afterTaskIds=[]；B creationKey=B/afterTaskIds=[A]；C creationKey=C/afterTaskIds=[B]。创建并hold不等于执行。
- A正式task.complete事务写task.completed事件及completionProof后，B才经business-event occurrence释放；B到C同理。
- 应核member.dependencies、completionProof.eventId/commandId、occurrence.trigger.triggerKind/eventId/actionId、instructionIds、hold解除时刻、execution.timeline.segments[].startedAt、execution.result.receivedAt、task.completed.recordedAt。

## Evidence-worker结论
- 已知81不能证明消费；必须随机nonce一致、B/C实际读取工具事件及文件SHA256独立一致。需共享全新授权目录，不能预置产物。
- 公开ai-tag=false不保证入站；群可见或发送success不能替代source reservation和三任务证据。
- 根据lead转交事实，本发送路径真实入站阻塞，不是协调功能失败或E2E通过；CLI/RPC/服务端/投影根因尚未区分。
- 最小动作是用户客户端在指定群一次发送冻结全文；不换账号、不逐个启动、不改库、不关回声保护、不走测试HTTP。
- 首次意见未独立复验原始JSON，已请求其独立回读本地原始证据后补现场结论；不能把初次意见称现场复验。
