# 第7轮：核心隔离回归通过，越界全仓测试停止

原执行database-test-mpj-defaults.log：ApprovalWholeWithdrawalDatabaseTest真实本机PG/控制器回归9项，0失败、0错误、0跳过，BUILD SUCCESS。

随后原执行自行追加无-Dtest的全仓mvn test。全仓包含SpringBootTest/ActiveProfiles(local)，本机日志与PID59992连接证实进入共享服务；不属于用户授权的隔离范围。发现后通过原任务context明确要求停止/排空、不取消任务、不修改共享或其他业务。第一次请求因旧revision拒绝，按当前revision2重发；HTTP等待超时后未重放请求，独立读回确认已接纳（requirementRevision3）。

原全仓Java PID59992/Maven PID46872已退出，专用PG也正常停止。后续原生收据与完整日志核对：全仓在11:52:06已自然完成，400项/0失败/0错误/1跳过，原job completed/exit0、cancelled=false。停止要求生效时它已结束，不能伪记为取消。原execution/session继续inputVersion3，限定Approval*Test。独立静态检查16个Approval*Test.java无Spring上下文注解，专用PG地址固定本机。

边界：已确认共享服务连接，无法仅凭本机日志证明没有共享副作用；未执行共享修复或回滚。全仓虽有真实成功结果，不作为本轮隔离验收证据。
