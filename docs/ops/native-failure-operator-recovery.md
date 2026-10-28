# 原生失败的人工对账

旧工具已有完整失败回执，但所属原生回合因后续工具阻塞以 `blocked` 结束时，普通自动对账仍保持原规则。人工失败处理可在原执行已排空、无活动会话或运行/停止中作业、原调用/参数/结果摘要及同回合终态均精确匹配后，结合逐操作绑定的成功只读调查，经当前 operator 请求的 `reply/check`、`reply` 记为失败并保留原 unknown 观察与可能的部分效果。

此路径不推断无副作用、不改原回合终态、不重放旧工具；缺失终态、aborted、取消、活动执行或错绑调查仍拒绝。当前请求已 answered 时不得复用或覆盖答复，先由原 Owner 按实际阻塞建立新的精确处理请求。

只读调查必须逐操作绑定 `readbackOperationId`，不能用普通业务审查或另一条操作的调查替代。旧查询已有错误回执时不重复调用原查询来补证。调用 `/reply/check` 时传当前操作摘要、需求/控制版本，只有零写检查明确通过才能提交同一请求；发生版本冲突时先读回当前状态，不能覆盖已接受的答复。

部署及原任务恢复按 [常驻通知修复本地部署](resident-review-local-deployment.md) 既有流程执行，不热替换活动代码。源码回归通过不代表真实机器已切包、操作已结算或业务已恢复；这些状态分别回读。

## Host 重启后缺失原生作业终态

原 operation 保持 `unknown`、原 job 观察值和缺失结果不变。受信的 Host 退出事实、精确原调用绑定、成功且排空的同任务调查，以及当前 operator 的正式 `reply/check`、`reply` 可以共同记录独立的 `host-restart-isolated` 审计；该审计不代表原命令成功或失败，也不补写 tool/result。

通过 `nativeRestartResolutions` 提交 operationId、原 operationDigest 和 scopeEvidence。首次 check 只生成固定只读探针，返回 ready=false，同时返回 `requiredScopeProbes[].managedCall`。将其中的小参数对象交给原任务中绑定同一 `readbackOperationId` 的只读执行成员，调用 `execution_restart_scope_probe`。Host 从原账本和原生记录重建计划并核对两个摘要，直接将权威 command（包含末尾 LF）交给原生 `pwsh`；不用手抄长命令、trim、换行归一化或包裹第二层 shell。续办原调查成员即可，不为取计划新建成员。

调用形式如下；值直接取本次 check 的 `managedCall.arguments`，不沿用历史摘要或其他操作的证据：

```js
execution_restart_scope_probe({
  expectedOperationDigest, expectedScriptDigest,
  scopeEvidence: { hostPid, hostLogPath, hostLogSha256,
    producerScopeReviewed: true, localEffectsOnlyConfirmed: true,
    excludeOriginalSourcesConfirmed: true }
})
```

此入口只在当前 DSH 原生只读调查、且绑定原 operation 时提供，不接受 command、目标操作 ID 或后台运行参数。内层仍经过原生 guard、operation 账本、job 登记和结果处理。原生外层 `tool/call/result` 保留受管实参及子结果；正式读取同时验证 command 精确相等、唯一的同 root 原生 job、producer 完成记录及成功且排空的调查。摘要陈旧、命令有一个字节变化、权限拒绝、多个 job 或缺失结果都不能核销。

工具调用成功和进程成功分开核对：原生前台 pwsh 即使返回 `isError=false`，也可能实际以非零退出码结束；受管入口要求 producer 的 `exit code: 0` 才返回成功。失败子结果保留在外层原生错误回执中，通用原操作调查按原 callId、参数及结果摘要读回，不换 operation 身份、不将 unknown 改成成功。原生 guard 在派发前拒绝时不产生已执行操作；不能为补证重放旧命令。

结果策略还可能在进程完成后拒绝该调用。因此受管回执分别保留 `operationObservation`（Host 实际写入原操作账本时的结果、取消与策略观察）和 `nativeResult`（原生工具管线最终返回的结果）。通用读回只用前者匹配原账本摘要，同时通过 `finalPolicyResult` 呈现最终拒绝；不得把策略拒绝内容覆盖进旧摘要，也不能因原 job 已完成而把最终 block 当作成功。隔离凭证仍要求账本观察、最终工具结果、外层结果及 producer 记录全部满足成功条件。

执行结束并完成原效果只读核验后，使用该执行的 executionId 和工具返回的 probeCallId 填回 scopeEvidence，再调用正式 check。ready=true 后使用返回的 expectedIsolationDigest 确认，账本将确认、审计和原人类答复原子持久化。原文 command 仍作为审计计划返回；已有完整的原生直接调用证据继续精确核验，不将手抄执行作为常规路径。重复确认只能复用同一正文。

内置 Windows 核验仅识别限定的本地 PostgreSQL 启动和离线 Maven 编译配方。它核对 OOM 原日志及提供者文件摘要、Host 和其残存子进程、启动时间窗口内具有 DSH 提供者路径归属的生产者，以及命令特有的 PID、端口和保留目录。历史 Windows Job 身份不可恢复时明确记录 unavailable，不能声称已证明其退出码。任何权限拒绝、遗留生产者、未完成调查、跨任务绑定、陈旧摘要或保留物丢失均拒绝确认。operator 还必须审查该配方只影响本地且排除原生产来源。

确认后，恢复排空使用同一审计引用，保留缺结果的历史调用。Host 拒绝重新派发同一命令摘要，并拒绝复用被保留的 PostgreSQL 数据目录。该约束覆盖本 Host 的受管操作，不是系统级 ACL；不得以该审计自动重放原命令、重启数据库或清理目录。部署必须先通过正式排空预检；若旧版预检因中断记录拒绝，不得手工改账本绕过。

## 安全维护切换

正式双包部署工具支持可选 RestartMaintenanceProposal。缺省路径仍使用原排空门禁；维护提案不是运行态核销，也不改旧 execution 的 drained、operation/job 状态或原生日志。

提案必须精确绑定当前 Host PID、所有仍为 host_restart 的未知运行作业及原摘要、明确的停止部署后恢复授权。每项核对原身份、输入、调用、唯一注册、缺失终态、取消请求及固定 OS 只读探针；其他任何未排空任务、组、执行、starting 操作仍拒绝。当前 Host 的常驻桥接服务不是任务写入证明；沿既有 SIGINT 流程停止后，全部子进程仍必须退出。核验器可被单独复制的默认模式仍不依赖仓库模块。

获准切换后，工具复核提案摘要，沿用单实例控制台 SIGINT 停止，确认旧 PID、端口和子进程退出，再重跑同样的隔离核验并比较账本摘要。旧账本保留未排空，维护证据独立记录。SQLite 一致性备份、完整性检查及配置备份完成后才安装；安装后使用正常启动恢复，再由正式 operator 接口完成原作业隔离审计。未核销前不得恢复业务写入或重放旧命令。

探针发现DSH 相关的遗留生产者时，即使原数据库 PID 和端口都已消失，仍拒绝维护；只能先查明其来源或经正常支持机制停止，不能通过删除提案项、放宽计数或改账本绕过。

生产者范围按原 Host／原作业 PID 的进程树及已核验 DSH 提供者路径判定；业务写入者另按原 PID、相关数据目录和端口判定。单凭进程名或整机创建时间不能建立 DSH 归属，无关 Claude、其他项目编译或其他数据库实例不应阻断本实例维护。编码 PowerShell 命令先解码再作目录归属检查。

因 Host 重启中断作业而在维护中取消的原任务，可通过原 Web reopen 入口重新打开：仅当全部阻塞均为精确绑定的 Host 重启原生未知作业、已请求取消且无其他未排空执行时具备资格。恢复后账本仍保留原 unknown，限定为针对这些操作的 DSH 只读调查，拒绝业务派发、跨操作调查及 Owner 原生写入；正式 operator 隔离审计生效后才恢复业务准入。普通 cancelled 任务不适用此例外。
