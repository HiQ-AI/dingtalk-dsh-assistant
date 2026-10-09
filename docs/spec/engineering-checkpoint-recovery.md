# 工程检查失败的最小续行边界

## 现场问题

Task task-83c651ebdbdb77584a06d1fcb6b9e255 同一Run已经从generation1推进至3。两次verify-candidate失败皆为dataset-build的固定测试路径不存在：安装依赖成功后node --test失败，yarn build尚未执行。两代apply-changes没有文件修改且tree相同。Owner把检查配置失败视作业务代码修复，通过input.accept/input.apply从第0节点启动，重复需求准备、本地验收规划、工作区和源码阅读。原始只读证据在docs/tmp/build-recovery-diagnosis.json与build-evidence-read.log。

## 约束与最小路径

不修改v18及更早冻结工厂的mapInput/execute/prompt/ownerContract源码；这些参与持久definition摘要。现有记录继续按真实installed工厂验证，不能以换digest绕过。无现场恢复或重启；正在执行的gen3保持运行。

1. 工程检查配置/输入缺失与真实断言失败分开。Host解码其自己写出的check日志，发现注册检查明确引用不存在文件时，视作待修正的检查前提，不进入自动业务repair-proposal。保留完整失败证据，不能跳过检查或把配置错误当任务代码错误。
2. 复用node.resume的身份、来源、control、requirement、lease、排空和问题去重门禁，为纯/read的verify-candidate提供明确同代重验准入；执行输入和候选保持原样，仅该失败节点重新领取lease，前置节点和其输出不变。Owner必须携带诊断与可核验证据，不因反复请求而重复同一失败。
3. 确有代码变更时才使用现有工程repair上下文；本轮不把input.apply简单改为suffix后宣称工作区已保留：代际变化还关联workspace/effect/candidate身份，必须另有明确候选增量修复合同才能复用。现阶段先阻止错误分类驱动的无效全流程重跑。
4. 缺材料不能成为no-change合格依据。来源材料传递与用户投影由并行service修改解决；旧冻结节点不靠关键词判断业务事实。新增准入必须依赖真实来源/材料状态，不能通过reason的中文措辞做过度意图判断。

## 文件边界与验证

Controller/store的节点恢复边界、task-workflow-contracts的工程检查分类、workflow-engineering的非冻结Host辅助入口及对应定向测试。保留service文件给并行负责人，不改worker Owner重评区域。回归验证覆盖：同代复验保留prefix/workspace/candidate；配置缺失不修业务代码；source/control/lease变化、未排空、已有下游效果拒绝；重复恢复幂等或明确要求策略改变；旧v18工厂摘要不变。

## 实施收窄：共享材料与检查配置

用户确认材料采用现有 Task 共享目录。正文继续只存 work/artifacts 的原 SHA JSON，共享索引列出来源版本与 current/history；工程读取工具按 Task 绑定按需读取。历史材料明确标注历史，不冒充最新授权。撤销材料全文 taskContext 复制与 materials checkpoint。新增材料只更新索引，不改变 generation 或冻结节点定义。

检查配置采用唯一内部 checks checkpoint：注册实际新检查配置生成的完整 workflow，保存 checkpointChecks 与原摘要/请求号；Controller 准备 verify-candidate 新输入，Store 对 Task 控制/来源、Run revision、旧新注册记录及排空状态做 CAS。只允许旧新记录除检查配置/审计字段外完全一致；当前 verify-candidate 必须为工程验证失败且后继完全未执行。保持原 Task/Run/generation、全部成功前缀、工作区与候选；仅更新该失败验证节点及后继的节点版本，不清除旧失败证据（审计 artifact 保存原输入/输出/证据引用）。不得直接改全局 profile 造成其他已注册 Run 摘要漂移。

## SG20：候选校验退回原提案节点

现场83c generation4的原提案有13条替换，其中11条有效、2条from===to。validate-proposal正确拒绝含空操作的候选；问题是现有node.resume只接受失败agent，不能把紧邻纯校验节点的明确候选错误退回已提交的agent。因此不修改冻结v18工厂，不删除模型条目，不重开Task/Run/generation。

复用Owner的inspectNodeRecovery/node.resume，限定已登记工程v18、inspect-and-propose成功且紧邻validate-proposal等待、4类明确候选语义校验错误（无效修改、修改类型、no-change证据、方案文档）。Controller核冻结validator纯效果、无输出；Store核Task/来源/输入/租约/CAS、全链排空、无提案和下游效果、其后节点从未执行。原agent的input/session保持不变，原提案及校验失败引用记录到正式恢复事件；agent设ready，validator设blocked等待新提案。仅agent纠正及validator重验，所有先前节点不重领。

原validator已用过的lease不归零；仅正式node.resume审计明确退回的紧邻validator允许保持blocked非零lease，避免租约碰撞。重复同一候选错误仍按原problemKey一次恢复门禁拒绝，不能无限重试。未知错误、下游已执行/效果、新来源/暂停/未排空不放行。

## Owner诊断身份的闭环

纯validator失败时，恢复目标是其前置Agent，但失败工件身份仍是validator，不能要求两者nodeRunId、lease和inputDigest相同。Host恢复快照显式携带validationNodeRunId、validationLeaseEpoch、validationInputDigest，ExecutionController先与当前validator节点复核；Owner仅读取并引用完全匹配该身份的原失败工件。普通Agent失败仍匹配Agent自身身份，不放宽输入、来源、CAS或一次续行规则。

检查失败的候选源码修复：原 changeInput 全量计划导致整代准备重复；在已准入 repair 事务内对明确 verify-candidate 失败保持原需求/代次/工作区，重入 inspect 后缀，保留原候选差异并重新验证。只允许后续未执行且无外部效果，配置checkpoint仍独立处理。证据见 round-56。

本地验收配置 checkpoint 允许精确重评 `prepare-local-acceptance` 的 `LOCAL_ACCEPTANCE_PLAN_INVALID`：该节点必须 code、已排空、无输出，前缀全成功，后续只能未执行 ready/blocked，本地准备及后续无任何效果；Controller同时核对新旧定义只允许 pure/read。维护与Task/Run/需求/配置CAS仍保留。事务记录原节点inputRef/inputDigest/lease/waitReason和失败工件引用，再清理纯准备失败以重评方案。成功工作区、代码候选、构建检查保持；define/plan因配置变化重评。其他错误、外部效果不适用。

## v18 本地准备效果声明与实际效果

真实v18 factory的 prepare-local-acceptance/version1/code 声明唯一 workspace.prepare；其validatePlan在local.prepare之前执行，计划错误并未发生准备效果。此前Controller仅接受pure/read使真实定义无法沿受管checkpoint恢复。仅对该精确节点允许原factory唯一workspace.prepare集合，不允许混入其他effect；Store现有无output、全drained、全部前缀成功、local起实际effect零记录与维护/任务CAS保持不变。测试使用真实v18 factory保留define/plan/prepare-local实现及效果元数据，隔离业务执行边界，不以手造pure节点代替。

## SG22 必要依赖候选与自然语言仓库路由冲突

现场已授权必要dataset依赖仍在prepareTask被原需求唯一命中dataset-web的routingTerms拒绝。insertDependency先准备候选定义再提交计划，故不能要求尚未存在的已接纳依赖stage。最小修复沿原StageContract传递候选stage、当前beforeStageId/planRevision；registry从当前Task计划和需求独立回读，重新核来源作者/版本/原文、配置dependencyRepositories、原UAT及精确候选objective/验收。仅此已核候选可优先于自然语言路由；首次任务选仓和普通prepare仍拒绝冲突，不增加自选跨仓能力。真实Run/计划插入继续由原事务CAS完成。

## v19 三节点分离：旧Run接入预研（只读，尚未实现）

目标三ID不变：inspect-and-propose仅技术方案；validate-proposal做语义评审；apply-changes独立Agent通过受信编辑工具执行。v18 factory文本必须保持，v19独立工厂。此节不表示迁移已实现或已执行。

### 已有接口能力与不能复用的边界

- `execution-store-worker.js input.apply`（约402）：保留成功前缀，但后缀generation+1，沿旧nodeVersion/executor；不能用它假装同代executor升级。
- `run.workflow.checkpoint`（约652）：原Run/gen同步Stage摘要，具维护、来源、Task/控制/CAS、排空和effect检查；只允许checks/localAcceptance配置差异，节点数量/顺序/executor必须保持。不能把v19放进checks提案。
- `run.workflow.migrate-index/migrate-read`（约582/602）：特定旧code节点版本升级，可保Run/gen；只接固定旧节点/错误/状态，不能套三节点。
- `run.workflow.replan-direct`（约621）：gen+1且仅workspace效果，不能套已有编辑候选。
- 未发现通用definition.revise API；workflow.register只保存新定义，不会更新Run/Stage。

### 最小正式接入建议

新增明确v18→19原生定义迁移，复用checkpoint现有维护/Task/来源/版本CAS，不增加通用迁移框架。只接原Task、同Run、同generation、当前定义18、排空、无pending input/未知或在途效果，保留全部仓库/需求/UAT/授权参数；校验两工厂除三节点及必要版本标识外保持相同。

`execution_nodes`有UNIQUE(run_id,node_id,generation)（worker约224），故同代不能将旧row标superseded后插同ID新row。事务应先保存旧三节点executor/version/input/output/session/lease审计，再更新原row的三节点定义元数据、清失效session/input/output绑定，lease不归零。Controller输入envelope绑定workflowDigest（约190/276），受影响输入必须由新工厂mapInput创建；Run与当前Stage同事务切新digest。旧原生会话停止且排空后新节点接新会话，不伪造旧会话归属。

已成功的旧inspect/validate输出含补丁，不能直接冒称v19设计/语义评审成功。若必须接v19，从inspect重新执行三节点的必要语义工作，保留前4准备节点、真实工作区与已完成编辑候选；新编辑工具仅追加当前必要差异，旧effect不得重投。将既有编辑/verify/失败工件作为受信历史材料而非新的技术方案输出。

### 现场三个Task的不同处理（读取时快照，部署后必须再读）

- SG20：v18/gen6/rev10，inspect waiting execution_tool_failed，已drained。若新需求仍要求修代码，可从inspect接v19并保留前4成功准备节点。
- SG18：v18/gen4/rev13，apply waiting ENGINEERING_NO_CHANGE_WORKSPACE_DRIFT。不能从新apply直接吃旧proposal；先沿当前卡点修复稳定运行，后续若迁v19，从技术方案起重验，保留已有候选及成功编辑效果。
- SG22：v18/gen7/rev10，prepare-local waiting LOCAL_ACCEPTANCE_PLAN_INVALID。三编辑节点已成功，当前优先原v18必要后端依赖/本地验收；不应仅为定义升级重做成功编辑，确需新修复时再接v19。

反例必须覆盖：另Task/旧req/UAT/原stage漂移、非18、活跃会话/未排空、未知效果、已推送等发布效果、三节点之外改变、旧补丁冒充新设计、旧编辑重投、任意Agent编辑tool扩权。Agent目前仅pure/read（Controller约73）；新受信编辑工具必须沿managed-edit原授权/effect账，不能通过将executor改agent同时泛放workspace.edit规避门禁。

此次仅完成接口源码和现场状态只读核验，未修改Assistant、未live迁移，待v19设计与测试明确后实施。
