# 第六轮：原 Task 明确需求与原生审批的真实接续

第五轮真实失败记录保留：末调查 Run 成功错误封闭上下文修订、原生审批等待未进入自动对账、明确目标与 Owner 活动验收不同步。三处修正都沿既有任务、事务和效果账，没有新调度器或持久 schema。

定向验证：业务终态及上下文入口6项通过，原生审批自动对账/原恢复/控制屏障13项通过，批准/驳回/两轮修订3项通过，原子验收同步6项通过。明确替换旧验收保留 inactive；普通补充不替换。成功阶段与输出引用保留。同generation/nodeRunId未批准保持等待、批准或驳回恢复原Run，不重发已发送外部写入。

最终部署及原 Task 的工单/SQL/审批、真实等待原因和群通知回读将在本轮追加。生产执行未发生，不能以模拟批准测试代替真人批准。

真实接续：第三包PID46632，100文件SHA256 9c19c55ebea086efc242070421185e83c68f95fed8f56db35e7d546ce59d740a，独立Resume ready=true。原Task context接受到revision2，SQLite证明旧3验收inactive、新3验收绑定真实web-context来源，原三个成功阶段与产物保留。Owner正确advance task-data-change候选，但core计划校验只读message_runs而不承认Host已接受Web来源，真实落账失败TASK_STAGE_SOURCE_CONDITION_INVALID；新反证保留，统一来源后须再验证。
