# 原生失败的人工对账

旧工具已有完整失败回执，但所属原生回合因后续工具阻塞以 `blocked` 结束时，普通自动对账仍保持原规则。人工失败处理可在原执行已排空、无活动会话或运行/停止中作业、原调用/参数/结果摘要及同回合终态均精确匹配后，结合逐操作绑定的成功只读调查，经当前 operator 请求的 `reply/check`、`reply` 记为失败并保留原 unknown 观察与可能的部分效果。

此路径不推断无副作用、不改原回合终态、不重放旧工具；缺失终态、aborted、取消、活动执行或错绑调查仍拒绝。当前请求已 answered 时不得复用或覆盖答复，先由原 Owner 按实际阻塞建立新的精确处理请求。

只读调查必须逐操作绑定 `readbackOperationId`，不能用普通业务审查或另一条操作的调查替代。旧查询已有错误回执时不重复调用原查询来补证。调用 `/reply/check` 时传当前操作摘要、需求/控制版本，只有零写检查明确通过才能提交同一请求；发生版本冲突时先读回当前状态，不能覆盖已接受的答复。

部署及原任务恢复按 [常驻通知修复本地部署](resident-review-local-deployment.md) 既有流程执行，不热替换活动代码。源码回归通过不代表真实机器已切包、操作已结算或业务已恢复；这些状态分别回读。

## Host 重启后缺失原生作业终态

原 operation 保持 `unknown`、原 job 观察值和缺失结果不变。受信的 Host 退出事实、精确原调用绑定、成功且排空的同任务调查，以及当前 operator 的正式 `reply/check`、`reply` 可以共同记录独立的 `host-restart-isolated` 审计；该审计不代表原命令成功或失败，也不补写 tool/result。

通过 `nativeRestartResolutions` 提交 operationId、原 operationDigest 和 scopeEvidence。首次 check 只生成固定只读探针，返回 ready=false；必须在绑定的只读调查中真实运行该探针，再携带 probeExecutionId/probeCallId 检查。ready=true 后使用返回的 expectedIsolationDigest 确认，账本将确认、审计和原人类答复原子持久化。重复确认只能复用同一正文。

内置 Windows 核验仅识别限定的本地 PostgreSQL 启动和离线 Maven 编译配方。它核对 OOM 原日志及提供者文件摘要、Host 和其残存子进程、启动时间窗口内未归属的生产者，以及命令特有的 PID、端口和保留目录。历史 Windows Job 身份不可恢复时明确记录 unavailable，不能声称已证明其退出码。任何权限拒绝、遗留生产者、未完成调查、跨任务绑定、陈旧摘要或保留物丢失均拒绝确认。operator 还必须审查该配方只影响本地且排除原生产来源。

确认后，恢复排空使用同一审计引用，保留缺结果的历史调用。Host 拒绝重新派发同一命令摘要，并拒绝复用被保留的 PostgreSQL 数据目录。该约束覆盖本 Host 的受管操作，不是系统级 ACL；不得以该审计自动重放原命令、重启数据库或清理目录。部署必须先通过正式排空预检；若旧版预检因中断记录拒绝，不得手工改账本绕过。
