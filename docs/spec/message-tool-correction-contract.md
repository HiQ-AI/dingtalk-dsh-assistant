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

## Task 调查附件范围增补（实施前）

正式调查已收到工作簿全文，但 scope 仅含动作消息，工具回读对应文件消息被正确拒绝。复用既有 message.material 缓存和来源 snapshot：只对 requirement.materials 实际引用的文件消息/fileId，逐项核对同群、原快照 actor/version/body、当前附件身份及缓存正文一致，得到精确 sourceKey/version/resource 描述。调查 stage 输入补充这些来源范围及 readableMessageResources；不扩大数据库/写权限、不读取无关附件、不把附近所有文件纳入。

已运行调查不直接改冻结输入；若已成功不覆盖产物。受管只读恢复应仅对已排空的失败/等待调查、无外部effects及当前需求/计划/代际作CAS，通过既有 input.accept/apply重新冻结同run下一代，保留旧节点和证据，不创建重复Task。

## Owner 材料恢复事实

Owner 每轮 snapshot 复用调查阶段同一严格材料来源核验，提供 materialAccess.readableMessageResources。仅已有材料账正文一致、来源版本/身份和附件标识仍有效的资源进入目录，不扩大群权限或预读无关附件。对于失败/等待调查，Host 对比旧冻结输入的 sourceKeys/sourceVersions，列出 scopeRepairs（旧 run/inputRef 和可重建的来源）；这证明旧范围遗漏可修复，不证明连接器已读取成功。旧失败产物保持原状，Owner 应据当前事实重新核验，不要求用户重发已有附件。

## Owner阶段修复候选校验（实施前）
repairCurrentStage 仅在当前快照 repairable=true 且完整 repairBinding 逐字段相等时接纳。不支持或绑定不符必须在候选写入前给可纠正反馈；工具schema只在当前能力可用时展示该动作。计划需求版本落后时明确使用advance/replaceSuffix重评，不编造repairBinding，不绕过真实应用阶段校验。

## 已取消重复 Task 的受管删除（实施前）

现有 archive 只隐藏，不是删除。新增原生 task.delete，限定已取消、全部节点排空、无执行effects、无待应用Owner动作/输入、无跨Task执行引用或续跑家族。check通过只读query完成，零回执/事件写入。执行事务按外键顺序删除Owner和计划及执行实体，保留原消息/command/receipt以及删除事件作为防重凭证，拒绝同Task身份再accept/create。不修改规范Task；文件目录不在数据库事务内删除，本轮不自动清理session或共享artifact。删除前明确返回这些保留范围，避免把归档或文件清理当实体删除。

## 通用专业指导与冻结定义边界（启动失败修复前）

通用来源解释指导被直接拼入已有v5/v6节点prompt，导致历史定义digest漂移，原生启动正确拒绝。该指导不改变工作流拓扑、输入输出或结果验收契约，改由execution-session为当次模型请求注入独立systemPrompt section，与Owner共享；恢复已有冻结prompt原文。不伪造legacyDigests、不删除历史run定义、不关闭drift校验。历史定义启动及原生请求需分别验证。
