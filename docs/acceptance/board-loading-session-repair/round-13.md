# 第十三轮：私聊审批链路及真实投递反证

## 已确认原因

Resident 的授权列表已异步合并原生审批，DWS bridge 未 await；随后又仅按旧 humanBlocker 任务取件；工作流生产审批仅允许 Web。原 #857 待审是真实原生请求，却没有实际投递。第十二轮 waiting-reply 只是投影，不是消息送达证明。

## 修复与测试

复用原生审批和事件账记录冻结通知、发送意图、openTaskId、确认回执及撤回；引用回复校验私聊、消息和授权身份，仅完整批准/同意触发批准。Web/私聊共享首终态。真实 SQLite + 服务 + 桥接覆盖批准/驳回、模糊回复、身份/引用错误及 Owner 事件。

## 真实失败（保留）

首正式包 28694356429caa85ebd433ea93b1debacc43ef015135a13169cb75f60d4563eb部署成功、100文件一致、无历史备份、PID33964健康；恢复派发后首次发送被钉钉拒绝。真实日志 error code1001，说明uuid上限128，生成键实际156；无openTaskId，原请求保持unknown/pending。完整短词消息检索未找到新审批消息；未将检索未找到当作重发许可。

判定：private-approval-real-delivery FAIL。明确未发送证据来自平台精确错误、真实trace与同时间审计记录，不来自发送工具回执或猜测。后续修复见round-14.md。

私有证据：docs/tmp/private-approval-deployment-round14-20261002、simple-database-change-20261002/private-approval-server-rejection-proof.json、private-approval-live-requests.json。原生产工单905 NOT_STARTED，TaskRuns原响应为空对象，只读副本name列无结果；未批准或执行生产DDL。