# 收件箱精确失败与协议闭环

2026-10-26 开工快照；基线 dc41f69f，分支 worktree-inbox-failure-fix。沿用原 latency-data/source；不部署、不重放、不外发、不写业务账、不停止服务。

## 目标与证据

真实事项出现协议请求耗尽，但 HTTP 只识别 routingStatus=failed，导致语义处理永久显示 processing。群级 onError 同时广播 decision-failed，且可恢复 Host 错误、startup 补偿也会触发，因此该字段和原始错误文本不能单独决定当前消息终态。原生日志根因由 latency-data 只读核查；在拿到协议提交/返回证据前不推断模型独占耗时或放宽业务校验。

## 实施边界

1. 先以合成精确身份写 HTTP 红测；原生日志有具体协议缺陷时写对应原生红测再修。未知原因如实记录，不凭延迟推断。
2. 复用 Topic runtime 自己计算的当前请求身份，提供只读白名单请求快照（group/topic/revision、message/version/unit/revision、status/attempt/failurePhase/nextRetryAt），不在 HTTP 重算 hash，也不解析任意 lastError。运行时保留的 exhausted 请求可以关联旧持久状态，无需迁移历史 schema。
3. Topic blocked 和精确当前协议耗尽投影 failed；pending、可重试 Host failed 和 startup exhausted 仍 processing。完成/替代的旧失败不覆盖当前成功；旧版本、旧 Unit 修订、remove/merged、不匹配请求均不污染。
4. 来源 DTO 从原生 coordination.source.list 精确 sourceRefs + unit/revision + 当前 reservation generation 提取协调故障；accepted/needs_clarification/resolvedBy/frozen/移交优先，不把残留 lastError 当失败。读取异常返回503，不冒充空成功。
5. processingFacts 增加白名单 issues：phase/code/status/requestId/attempt/retryAt；status 为 failed/retrying。失败不赋 processingCompletedAt，semantic duration 保持 missing。通知送达/业务 Task 完成保持独立。
6. Observer 统一“处理失败”，详情区分归类、语义判断、Host动作、独立协调及恢复等待；筛选/刷新一致。

## 验证与交付

失败、重试、后来成功、旧版本/Unit、superseded/startup、多 Topic、通知与业务状态分离、隐私白名单定向测试。仅 fixture HTTP + 真浏览器，不连生产写API；源码测试和包 smoke 后新PR交付，不触发CI。README/API/ops同步。权威 goal/shared/matrix 仅主仓维护，本 worktree 生成精确同步补丁；历史 round/report/CSV 不覆盖，本轮红测 round-13、修后 round-14（先核未占用）。

## 用户追加：收发手动恢复（2026-10-26）

收件按原消息版本、activeUnitRefs 和当前请求凭据执行显式恢复；拒绝旧版本/成功/并发点击，复用 topicCoordinator.retryMessage 及独立协调原 reservation 身份，不复制消息，不清未知效果。Host blocked 必须具备既有可安全恢复证据，其他阻塞先修原因，不用手动按钮绕过。

发件按原 notification 及原生发送/回读账分流：有持久原生拒发证明才按原幂等身份恢复发送；unknown/starting 只回读核对；delivered/superseded/已撤回/退休禁止。严格 CAS + 同身份并发保护，显式操作仅一次，不建立无界自动重试。鉴权或网络未恢复须显示真实失败，解除后可以再按新凭据恢复。UI 展示可恢复/处理中/需先解除阻塞，测试收发两端、重复点击、旧态与已成功保护。

分工：lead 保留 HTTP/DTO/service/resident/Observer 与收件恢复；latency-source 先修历史 startup 快照后只负责 notification-delivery/dynamic-task-store 通知分支及通知测试；latency-data 继续原生日志根因只读调查。主仓权威补丁新增对应子目标及验收行；本轮不合并、不部署、不执行真实重放/外发。

## 用户追加：两条成功慢消息

新增两条 attempt0 成功慢消息的只读原生事件拆解，分别按本次 semantic 完成边界截断，后续共享决策跨度不累计。区分入口延迟、排队、含模型/工具的原生 turn、Host持久化和调度空隙；空窗没有事件证据就标未知，不称纯模型独占时间、不调无排队证据的并发。原 latency-data 与失败请求根因一起给反证与优化取舍，只有能重现、可验证收益且不削弱核验的点才实现。结论写本任务证据和新 PR，自始不重放真实消息/外发。
