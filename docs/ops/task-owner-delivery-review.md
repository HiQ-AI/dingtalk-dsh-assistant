# 原 Owner 暂停中成果评估

适用于已授权交付成果已在原任务范围完成，但工程执行仍保持暂停的现场。业务完整性仍由原 Task Owner 会话根据当前完整需求判断；这不是新的开发节点或新的任务。

本地入口 `POST /tasks/{taskId}/review-delivery` 沿用 loopback/允许 Origin、配置的 webActorId 和原任务群访问限制。提交 requestId、expectedRequirementRevision、expectedControlRevision、reason 和 facts（原 Run、已交付工作区/提交/PR、已提交 verification.json、实际 JUnit、清理查询及 jar 的文件路径/摘要）。外部证据文件必须在当前已授权需求明确引用的路径中。

Host 只读回查实际 Git、当前 Draft PR、JUnit、源码适用性和构建摘要，生成不可变事实 artifact 和审计事件。原任务必须已暂停、节点及效果已排空、原 Owner 会话已绑定；普通暂停和普通事件不能触发该通道。原会话只允许 complete/wait/block，不允许 advance、计划变更、工程重跑、merge 或部署。当前需求/计划/控制/授权及输入变化使评估失效。

完成候选必须实际读取成果事实，并逐项覆盖当前验收项；Host 接纳前再次回查可变交付事实。真实 Owner 接纳并应用后更新任务展示结果，工程暂停、原 Run/节点/effect 历史保持不变。缺少旧格式节点回执本身不构成重跑理由；实际未验证范围仍由 Owner 如实报告。等待事件按原因保留 workflow.waiting/confirmation 语义，真正失败使用 workflow.failed，稳定重复观察不重复唤醒。

测试：`node --test test/task-owner-paused-delivery-review.test.js`。部署使用 `scripts/deploy-local.ps1`，新包自测及独立窄审后安装，正式 Readback 和 Resume 结束后再提交评估请求；禁止直接改 SQLite 或历史回执。

### Accepted candidate evidence at final completion
An original Owner candidate acceptance remains a candidate checkpoint, with its original requirement revision and businessCompleted=false. After authorized merge/deployment stages succeed, final completion may cite this checkpoint and its reviewed facts as original-owner-candidate evidence. Host rechecks the current authorized repository, HEAD/tree/PR identity and original evidence-file hashes; it does not replay development or test runs. The evidence is separate from task queries and does not itself mark any acceptance item satisfied. The Owner must still assess every current acceptance item, all required stages and effects must be complete, and the existing semantic completion validator must accept the actual scope. Fixture, external login and other unverified boundaries remain explicit. Production approval and duplicate dispatch protections are unchanged.
Native UAT completion reads the immutable current-generation succeeded/drained inspect-built and inspect-runtime receipt bodies into hostExecution.runtimeEvidence. Candidate diagnostic evidence uses the native accepted candidate ref/reviewRef and current task/revision; semantic rejection remains a rejection and is made readable to the original Owner.
Final Store reference binding also recognizes the native original accepted/applied candidate acceptance event and its reviewed evidence refs. This binds authenticated evidence; current-plan, actual semantic validation and final manifest remain required.

### 已对账 workspace 预检失败的终态收口

原工程 run 已暂停且排空，唯一 workspace 效果已正式对账为 `failed / preflight / mutationAttempted=false / WORKSPACE_PREPARATION_ADDRESS_COLLISION` 时，可使用 `scripts/reconcile-workspace-collision.mjs` 的 `finalize` 模式。先按原 proposal 执行 `check`，核对 proof digest；在正式维护 draining 且无忙碌执行者的范围内，以原 digest、maintenanceId/revision 执行 finalize。

该模式消费同一冻结操作的当前失败回执，通过 `node.failure.reconcile-workspace` 正式 Store 命令记录节点和 run 的 failed 终态并阻塞旧阶段，保留效果、观察、证据与成功前缀。任务继续暂停。只有精确 run/node/input、generation/lease 和任务 requirement/plan/control CAS 匹配才允许；任何额外、成功、未知效果，执行写入、非预检、未排空或待处理输入均拒绝。完成后由原 Owner 消费已有真实候选并修订发布后缀，不伪造工程成功 final，不重跑旧开发。


### 流程结束与任务结案

新建的会话管理任务在所有固定阶段成功后，计划状态为 succeeded，任务状态仍为 pending，等待原执行会话判断整个业务目标。会话可继续推进或说明等待条件；只有其明确提交 complete，核心结果和当前任务记录通过既有校验并成功应用后，任务才转为 succeeded。单个 Run 或流程输出 completed 不自动代表业务目标完成。

不迁移、不重新打开历史 done。暂停交付审查仍只保存原会话的审查结果，不改暂停控制、任务或阶段记录，不派发执行。

无固定阶段的查询任务也由原执行会话显式结案。冷启动认可同任务、当前需求与计划下原生已接受且已应用的 complete 记录及应用审计；仅有候选、未应用或陈旧决定不构成完成。该恢复判断不增加交付材料格式或编排验收职责。
