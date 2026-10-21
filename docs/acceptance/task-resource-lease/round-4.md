# 相关大回归与查询放大审查

已配置原生 profile，执行五个相关测试文件：dynamic-task-store、dynamic-execution-resources、task-session-service-native、task-session-observability、task-session-package-native。共 152 项：151 PASS、0 FAIL、1 CANCELLED、0 SKIP，约 298 秒。

唯一未通过项为 npm tarball 任务测试的 30 秒超时；另一解包 Resident 启动测试通过，全部 39 项 service 原生测试通过，包括 32 轮续办、真实取消、需求修订、未知通知、容量及两项新增资源场景。输出在 round-4-regression.log。超时项另行单独复验，不能把本轮当全绿。

最终静态反证确认资源投影存在 N+1：一次 execution.list 约 1+N+ΣK 次 SQL，调度每轮两次全量查询会放大读取。改为每次公开查询只读取一次资源表快照、内存投影全部执行，保留 claim/start/restart 的实时事务校验，不跨请求缓存。新增第 17 项以实际 SQLite statement 读取次数验证固定上界，并验证释放后的实时持有者变化。最终改动的定向复验证据见下一轮。
