# 等待任务进度与通知验收计划

目标：已完成阶段独立计入进度；必要等待清楚通知相关人；通知投递与跟进可恢复、可核验且不无限循环。

源码：runtime.js、store.js、task-input-revision.js、task-progress.js、topic-runtime.js、Observer web-client.js。

验证：定向 Runtime/阶段修订测试、全量 pnpm test、Web 构建、包内容检查。真实本机安装须先排空运行 Task；当前服务和历史等待任务不在本轮源码验证中修改。真实 DWS 送达须独立回读。

实施取舍：等待身份采用现有 task-result 稳定键（任务/版本/结果指纹），等待起点采用 stateHistory，投递与两次跟进采用现有 Outbox 键及 deliveredAt 推导；不额外保存一份通知状态或模型草稿，避免双写分叉。正文由 Host 根据已审阅的 waiting 报告生成，批准等待后立即排入现有 Outbox。旧等待记录保留，不在启动时批量补发或催促；指定的当前历史等待任务经人工只读核对后，调用定点更正接口，稳定键保证只补一次明确暂停的说明，送达后才启动跟进计时。
