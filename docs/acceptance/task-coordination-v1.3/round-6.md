# 第六轮：真实群三任务依赖验收

## Preflight
- 保留已部署9f415100d51c876dcc79909ac13637b38fdf6ae3（PR256 OPEN，origin/main=5a1ab91+1）；两包2.1.0；PID73984；独立直连 health=ok/real/inboundProcessing=true/recoveryIssueCount=0。
- 测试群唯一 ID cid2HnVI0zvC2dOr5RmJ5ZCJg==；DWS读回 complete=true；发送账号唯一 current/isOrgCurrent=true。
- 本轮正文冻结于 ingress-request.txt，专用产物目录 D:/baibu-agent/docs/acceptance/coordinator-abc-20261024-r2 在发送前不存在；lead 未人工创建任务/产物。

## Attempt
- 发送接口：dws chat +send-to-group --group cid2HnVI0zvC2dOr5RmJ5ZCJg== --ai-tag=false --yes。openTaskId=YfqqJgAsi4ZLsvT/s89GSH/XoWIjPDkrwHnn2IfpwTU=。
- DWS独立回读：messageId=msg2U3HmEqVemsd40enEG+zEA==，createTime=2026-10-24 18:40:49，conversationId正确，complete=true/count=2/failures=0；但 messageAiSendFlag=DWS。上一轮R1同样为DWS，messageId=msgrLQj9V80bAV7DhawZLO+Pw==。
- 插件独立状态回读：测试群 messages=7、routingRevision=7、topicProgress total/pending/unrouted=0；没有R2 message或coordination reservation，未取得本轮任务创建证据；目标目录仍不存在。发送成功不等于真实插件入站。

## Result: BLOCKED (external channel identity)
- 已证当前 dws v1.0.63 的 send-to-group 两次实际发送读回均为 messageAiSendFlag=DWS；messages-send 仅做dry-run，未执行真实发送，不能据此断言高级入口实际结果；公开 --ai-tag=false 未改变实际消息标签，且 dry-run arguments 不含 aiTag。正式回声门禁按 assistant actor + DWS 丢弃，不能为验收关闭或绕过。
- 目前只能证明本发送路径未形成可处理入站，尚无证据说明插件协调器业务或部署失败；CLI、服务端标记与查询投影中哪层根因未收敛。未重放未知消息，未人工创建任务，未修改配置，未向其他群发送。
- 最小恢复动作：用户在指定群用钉钉客户端作为一条新消息发送 ingress-request.txt（建议先发送round-6完整正文，保留ABC1024R2；不要转发/拆分/引用R1/R2），发送后只需告知发送时间或消息ID。lead随即独立回读消息标签、source reservation、三任务和产物。
- 未写 report.md；不能把群可见、DWS发送成功或程序测试替代真实入站E2E。

## Local raw evidence
- docs/tmp/coordinator-abc-validation/round-6/ingress-readback.json：DWS独立查询原始ledger。
- docs/tmp/coordinator-abc-validation/round-6/group-after-send.json：插件本群持久读取。
- 原始JSON含旧消息，只在本机保存、不提交；冻结本轮测试正文与独立队友摘录可以入库。


## Root-cause limits
- 候选1：CLI未正确传false。dry-run参数不含aiTag支持此可能，但不能据dry-run断言实际RPC，未证实。
- 候选2：服务端对代理调用强制DWS。结果兼容此可能，但没有服务端原始请求与日志，未证实。
- 候选3：查询或入站投影统一标DWS。结果兼容此可能，但无法区分投影与服务端行为，未证实。
- 仅收敛本路径真实入站阻断，不把候选根因写成已定位bug，不改插件安全门禁。

## Independent review
- evidence-worker于18:48:34+08:00独立回读两份原始JSON、round记录、矩阵及当前本群HTTP，确认targetMessages=0/targetReservations=0。详见round-6/team-review.md；不只依赖lead转述。
