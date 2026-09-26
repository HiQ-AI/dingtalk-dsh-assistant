# 任务步骤耗时

复用编号时间线，在状态同行追加低强调的等宽数字耗时。运行中每秒更新；未执行显示尚未开始；等待显示本次执行耗时，不累计等待时长；缺失事件显示耗时未记录。保留原编号、布局和历史按需加载。

当前 execution_nodes 无时间列，execution_events 已记录 claim/commit 的时间。Worker 内按递增 seq 分页读取已提交事件建立只读时间投影；claim 的 binding 确定 nodeRunId/leaseEpoch，commit 的 runId 对应最近 claim。重试按租约隔离，旧代/未知终止不猜结束时间。不改 schema 或业务命令，不增加诊断接口请求。节点查询携带 startedAt/completedAt，历史节点共用该投影。

验证：真实 Store claim/commit/重开后时间稳定；浏览器完成、运行计时、等待、未开始及缺失时间；窄屏无溢出、无新增网络请求。定向测试及本地安装回读分别留证。
