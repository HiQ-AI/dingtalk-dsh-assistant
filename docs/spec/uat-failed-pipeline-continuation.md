# UAT 流水线失败收口与原任务接续

## 已确认问题

前端流水线 #319 达全局600秒后 killed：clone445秒、buildkit142秒、restart9秒，通知未完成。当前 release adapter 把所有无成功流水线情况返回 unknown；service只推进全部 succeeded；controller将所有非成功效果作为等待。已知远端失败因此无法收口，不得绕过该账本直接重发。

## 终态收口方案

仅对 uat-deployment/build：完整同目标分支、同commit扫描，存在明确失败终态且没有进行中或success时，返回 failed 收据，包含 operationKey、commitSha、pipelineNumber、pipelineStatus和证据引用。success既有语义不改；无流水线、列表不全、读异常、未知状态、正在执行均保持unknown。rebuild不作此改动，因为旧失败不等同新重建失败。

Host以单一校验函数确认effect的类型、适配器、冻结payload与终态失败收据一致。service仅允许本waiting节点的该已知failed效果进入一次原生recover；controller再次读取原效果，不派发写，将可信失败提交node.failed并保留原始receipt证据，驱动Run failed和任务阶段blocked。其他类型failed或证据不全仍等待。工作流定义/节点函数和digest保持不变。

定向测试覆盖所有失败终态、进行中优先、成功不变、错commit/分支与不全列表拒绝、重建旧失败不误判；原生service/controller用真实隔离Store确认unknown→failed→node/run终态、单次发送、不重复恢复、失败收据留存。

## 同任务重建接续

Host 在真实 Owner 恢复循环中识别 Web 原始明确三阶段（工程、UAT 合并、UAT 部署）的失败部署。仅当前第三阶段已知 failed 且所有节点/效果排空、前两阶段成功时，复用 plan.revise 保留成功前缀，将第三阶段替换成一次 task-uat-rebuild。旧失败 stage/run 保存在旧 plan revision，重建失败不会自动循环。

重建输入仅从原部署 Run 的冻结 requirement 和同 execute-build 节点可信失败效果构造；要求工程/合并源仍为同任务已成功阶段，原部署 evidenceRefs 绑定前一合并 Run。匹配重建白名单时 repository、environment、service、branch、Woodpecker、Kubernetes、registry、entryUrl 必须与原部署白名单完全相同且唯一；commit 不接受模型或请求覆写。继续已有重建预检、Web 审批和运行制品回读。

不改 schema、工作流定义或 digest。plan.revise 与 input.bind 的间断通过固定前一计划 revision / stage attempt 推导原失败 Run，再执行相同可信检查接续；已绑定输入不会重复修订。Owner 完成校验只允许有原失败源证明的这种三阶段替换，不能作为任意工作流变化放行。现场已有 dataset-web-uat2-rebuild 和 dataset-uat3-rebuild 配置，无需变更 profile。


## 已失败流水线发生部分部署时的重建证明

#319虽全局超时 killed，但 buildkit-build-and-push 步骤 success/exit0、镜像已发布，当前全部 Ready Pod 已运行同提交镜像。原重建证明只接受失败前成功流水线的制品，错误地将本次同提交部分部署视作更新版本。

最小修复：readBuildEvidence 的默认行为仍要求pipeline success；仅显式 expectedPipelineStatus=failure/error/killed 时允许读取该精确终态流水线，仍必须唯一 buildkit 步骤 success/exit0、日志归属该step且唯一export/push digest一致，并返回pipeline/step状态。重建证明优先核对本次失败流水线同commit的已成功build制品及Registry manifest，全部Pod精确匹配才认可；若本次build未成功或Pod不匹配，则仍可用旧successbaseline证明。当前制品已能完整证明时不再依赖可能已过期清理的旧镜像。不得接受混合新旧副本、未知digest、更新流水线或失败build步骤。无现场写入。
