# 第 19 轮：旧报告通知冲突修复

## 修复与本地验证

- Owner报告通知先按稳定eventKey查账，复用历史已送达记录，不因新引用来源或新增投影字段重发。
- 逐事实隔离准备与回读错误；诊断存入既有message_items，并由原message.run状态返回notificationDiagnostics。同一未解决错误不重复写账，成功后标记resolved；其他prepared/unknown通知继续处理。
- 消息账本、事项影响、真实服务、HTTP集成 **270/270 PASS**；通知 **12/12 PASS**，包含旧报告跨command送达复用，以及坏事实不阻断unknown回读和诊断幂等恢复。
- 对正式控制库119条历史做只读模拟：全部扫描无错误，原#111待发通知可达claim路径；所有command拦截，运行库写0、外发0。该模拟不替代真实发送验证。
- 新Assistant包99文件与源码一致，摘要见round-19-packages.json。继续使用已核验Observer包。
- 接续维护零写部署预检通过，正式安装和重放回读正在执行。

## 本机证据

round-19-integration.log、round-19-notifications.log、round-19-deploy-check.log；docs/tmp/message-processing-deploy/notification-dryrun-summary.json与notification-evidence/。原始消息及模型输出不提交公开仓库。

## 正式运行回读

- 补充包已部署，新PID36676，双包文件一致，认证Web303/200、health=ok、recoveryIssueCount=0；正式Resume后maintenance revision159、active=false。
- #111、#113的等待通知及#115的系统失败通知已独立回读为delivered，证明旧Owner报告冲突不再阻断通知。原始ACK/回读摘要留本机。
- 重放暴露新的时钟缺陷：维护期reprocess已activate，#115尚无任何节点就因MESSAGE_DEADLINE_BEFORE_CLAIM:S:$被置为needs_attention。已进入维护revision160并排空，继续修复首次领取前不应消耗执行窗口的问题。
- A14本轮仍FAIL；真实已送达的失败通知不等于成功承接。
