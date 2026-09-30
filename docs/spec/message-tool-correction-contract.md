# 工具纠正与 Owner 输入契约

## 已核验问题

2026-10-01 真实回放中，Owner 将 dws 来源引用放入成果 evidenceRefs，被 TASK_OWNER_REF_INVALID 拒绝后整轮结束；只读调查读取未授权路径，被 QUERY_SCOPE_DENIED 拒绝后整轮结束。拒绝本身正确，终止纠正机会导致任务卡住。Owner 重试再次追加完整快照，使同份工作簿在会话中反复出现，随后真实服务端拒绝上下文。

## 实施边界

- 复用 execution-session 已有 correctable_error 机制，仅将登记为 read 的查询能力的 QUERY_SCOPE_DENIED 归为可纠正；拒绝仍发生，不执行被拒绝操作。权限换代、证据核验失败、未知错误及业务写效果不降级。
- Owner 提交阶段只对明确的输入/引用契约拒绝返回 received:false 与具体反馈；仅持久接纳成功才停止本轮。取消、旧租约和未知存储结果保持致命，不重发未知写入。纠正受原有步骤/超时预算约束。
- Owner 的完整事实保留在已冻结快照；后续同会话重试不得再次复制未变更材料。先核对原生持久会话/投影能力，采用明确的当前快照读取契约，不能裁剪事实或丢失审计。
- 同批连续事项复用现有原子 fact 与唯一 create：以携带完整阶段条件的最新原文为主动作，其他来源先落事实；首次 Owner 前冻结全部来源和约束，不新增 taskRef 或迁移。

## 验证

真实原生 Loop 测试：被拒绝读取后合法读取/提交；Owner 非法引用后合法提交；旧租约、取消和未知错误仍终止；同session重试只提供当前完整快照且旧事实仍可回查。生产库、配置和外发均不涉及。

## 受管 Owner 恢复入口增补（实施前）

现有 IM Task 的 Web context 入口要求已有执行 run，不能恢复尚未建立计划的 Owner。新增 POST /tasks/:taskId/retry-owner，只允许配置的本地 Web 执行人且原任务访问校验通过。请求携带 retryKey、reason、expectedOwnerRevision、expectedLeaseEpoch、expectedRequirementRevision、expectedControlRevision、expectedLastFailure。事务仅接纳 active Task、blocked Owner、至少三次已释放失败、无当前 turn、无未应用候选，且失败属于 NO_DECISION/TIMEOUT。所有版本和失败码精确匹配。

恢复追加 system.recovery 事件，原因和执行人保存在原任务 artifact，清零失败并设 pending；不更新 requirement、阶段、Task 身份、Owner sessionId/epoch。相同请求走既有命令回执幂等，失败或版本变化不伪造恢复。通过现有 recover 调度同一原生会话，旧输入投影按上述契约更新；不伪造 SESSION_NOT_FOUND，也不重置原生 compaction 私有状态。真实压缩仍失败时保留事实并停在原生失败路径。
