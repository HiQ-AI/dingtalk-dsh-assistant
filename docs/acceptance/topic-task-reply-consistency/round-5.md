# 通知投影恢复最终验证

六文件定向重跑：`node --test test/topic-runtime.test.js test/task-session-service-native.test.js test/task-session-control-host-admission.test.js test/task-session-http-integration.test.js test/task-message-projections.test.js test/store.test.js`，原生 profile 同 round-3。

结果：178 tests，178 pass，0 fail，0 skipped，约 170 秒。新增证明稳定 outboundId 恢复、旧送达回复零重发、投影身份冲突拒绝、旧 prepared 收据重放后读取当前 delivered 状态，原 source/Task/会话权限测试继续通过。

最终 Assistant 包 SHA256：`efec25b8d3de5d38b42e67282c4ed4930260efc13f9b35ed4e1703633f2493e5`，230971 字节。Observer 沿 round-3 的精确包，源码未改。

第二次零写部署预检通过：同实例 4 个持久会话已排空，1 个 unknown 业务操作、0 个 unknown 通知；保留原 unknown 及其效果保护，没有假设它已失败或未发生。该操作为原任务恢复后执行核查中的新技术阻塞，独立于本次话题来源/回复恢复验收。

正式切换成功，新 PID 11876；profile 原字节不变，双包依赖、摘要、安装版本及监听独立回读一致，收信与 bridge 正常。实例 health 为 degraded，原因是保留的业务未知操作及相关任务状态；不宣称整实例业务全绿。

原消息 retry 的 HTTP 等待因随后新话题模型处理超过 45 秒而超时；没有重复发送恢复请求。独立读取持久账确认原决策及后续补充决策均 completed、各自操作 applied，话题 revision/processedRevision 均为 4，pendingRevisionCount=0，两个补充消息均 delivered、无 agentDeliveryError。原 Task 和 session 身份不变，来源由 1 增至 3，既有执行结果保留。

原回复原生账 state=delivered、sendAttemptCount=1，原 messageId 与送达时间保持；DWS 精确群/时间/正文搜索 complete=true、count=1、failures=[]，仅命中恢复前的 18:48:57 原消息。因此已确认旧回复没有重发，而非只依赖工具成功回执。

业务边界：原任务当前继续只读核查开发分支及 UAT 来源，仍保留原 web_fetch 的 unknown 保护。此次不声明分支核对、布局修订或业务验收完成，不清除未知操作、不改业务仓库。
