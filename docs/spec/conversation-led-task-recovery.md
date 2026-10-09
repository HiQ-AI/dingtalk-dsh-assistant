# 会话主导的持续任务恢复

## 问题与目标

用户要求根治重复失败、报错、阻塞和终止，并明确会话与大模型是润滑剂。目标不是继续扩错误码特例：复用原Task Owner监视会话，让完整故障进入其持续上下文，模型主动读证据、判断原因、调整策略、指导原执行会话，并核验真正恢复与最终业务完成。代码提供真实工具与事实，约束授权及已发生的副作用；内部错误不被直接改写为用户需补充或业务终止。完成前不再提交代码，保留此前已提交内容与现场审计。

## 当前事实与盲点

- resident.js:274 每5秒扫描；task-owner-controller.js:81起按故障及恢复能力事件驱动Owner。10:26实账SG19/20已有自动repair并applied，因此“监视没运行”不成立；WebObserver仅展示。
- task-owner-store.js:589起将非暂态动作应用失败置blocked；pending队列排除此动作，失败没有形成新的可行动诊断回合。SG22因此无法靠普通轮询继续。
- workflow-engineering.js:287、454、570：读取证明仅在registry内存Map；重启后SG18无新增修改再次遭CONFLICT_NOT_READ。应让原会话读取真实文件并继续；现有可信历史证据能够复用时不要逼模型重复整轮工作，不靠catch错误码冒充已读。
- SG19存在90个候选Java测试，Host选择两类均不存在，整个错误却统一成ENGINEERING_VERIFICATION_FAILED。Owner实际给出修改业务测试迎合错误命令的策略，因为仅暴露候选修复动作，Host检查修订不可达。
- SG22 native恢复证明曾通过，但实际HTTP expectedLastFailure枚举拒绝。工作树http.js已修且HTTP→service→store真实7例通过，尚未部署。说明入口链测试与真实结果证据必须完整，不能宣称store通过等于现场修复。
- 已成功编辑、最后submit失败的agent恢复，以及未知效果对账后继续，仍需用真实用例校准；不宣称本分析已根治或所有任务已完成。

## 三个候选及排除

1. 继续增加错误码、自动重试与恢复分支：排除。新异常仍碰下一层；不能理解Host选择错误与业务代码失败。
2. 新增第三个监视/修复会话：排除作为当前方向。原Owner已存在，工具和反馈断开仍在，还可能同时重复处理。
3. 原Owner持续诊断，原执行会话持续实施：采用。复用现任务目录、工件、read_artifact、currentExecution及recoveryContext；把工具拒绝和动作应用失败作为下一回合上下文，而非结束责任。只接通当前缺的少量Host操作，不造通用自愈状态机。

## 模型负责的闭环

1. 每次失败提供完整原始错误、实际命令、当前代码/环境与已发生的动作回执。模型读真实材料，不根据一个泛化错误码直接选固定修复。
2. Owner解释失败属于代码、工具参数、运行环境或Host配置，并给出能消除原因的新策略。例如测试选择错误先修检查命令；引用截短先读索引；读取记录丢失回原会话核当前文件；必要后端依赖沿原交办修正参数。
3. 原执行会话收到具体诊断及策略后继续本轮；普通参数错误以工具反馈纠正，同一上下文保留。模型检查工具能力和当前结果，避免每次重新生成方案或整轮重跑。
4. Host拒绝修复动作时，反馈拒绝原因、当前事实与确实可调用的能力给Owner，立即形成下一轮诊断；Owner换具体做法。无变化原样重试不算推进，亦不把整个业务目标永久终止。
5. Owner回读修复后的实际命令/文件/API/页面结果，确定故障原因消失，再继续目标；最终仍需业务验收。日志/源码/PR/运行版本/群聊送达分别取证。

## 最少实施接线

- 失败反馈：复用已有失败工件与Owner事件，把工具及动作应用失败的完整诊断反馈到原会话，去掉“非名单即永久blocked”的责任中断。
- 操作能力：让Owner调用现有原节点续行、受管Task级检查配置调整、必要依赖阶段；发现原因后实际能行动，不只写建议。可修普通参数由执行会话本轮完成。当前真正缺少的Host动作补一个清晰入口，HTTP与内部路径共用合同。
- 连续上下文：原Owner和原执行节点失败历史保留，继续原会话并附诊断策略，共享材料按需读；不为修复创建新Task或强制重跑成功准备。
- 事实边界：权限、暂停/取消、真实外部操作状态与验收由Host核；不把丢失的内存标记、固定测试选择和错误码白名单当业务授权。原操作已发生时先回读，再决定是否续行，不盲重发。

## 唯一交付判据

用五个原任务证明，而非再发一个只有单元测试的新版本：SG18恢复原候选并实现导入导出需求；SG19修复派发并验证撤回通知真正送达；SG20完成七项交互；SG22完成真实结果Excel下载及前后端业务验收；SG21既有调查证据保持完整、不重新执行。故意注入工具参数错误、Host错误测试选择、重启及恢复动作拒绝，监视会话应自行读完整证据、选择正确修复、恢复原任务并完成验收；不再让用户逐条贴报错指导。完成群聊消息须清楚列结论、结果、下一步，完整送达另取独立回读。

## 用户追加：任务流程副本可动态调整

插件配置的预制工作流只作为创建任务时的起始模板。每个任务获得独立执行流程副本，记录来源模板及本任务流程修订；调整不影响模板、其他任务或历史执行记录。当前源码仅支持业务阶段replaceSuffix与工程checks/local-acceptance的窄checkpoint，尚不能称为任意任务节点自适应调整。

监视Owner根据原目标、完整错误及实际产物判断并调整未完成部分：增删/合并/替换节点、修改节点入参和预期产出合同、改变工具及验证方法、补必要依赖。普通参数修正优先原执行会话内完成；只有步骤已不适用时才修订任务流程。调整后的流程仍承担原验收目标，不能删掉真实业务验收来伪造完成。

入参引用Task共享材料和当前真实产物；调整产出要求时生成新工件，旧产物与已发生操作的回执保持可查。成功步骤按影响范围复用，确需重新验证时只重验受影响部分；已经发生的写入/发送/提交先独立回读，不因删节点再次派发。当前执行节点先结算当前调用，再切换流程修订，重启按该任务实际修订恢复。

实施优先复用现有reviseTaskPlan、workflow登记、工件引用和checkpoint的保存/恢复路径，接通Owner可调用的任务级调整能力；不为每种故障新增专用工作流或全局配置开关。具体可执行节点来自现有Host能力，不能仅让模型生成无法执行的节点代码。动态调整的理由、受影响节点与实际验证结果进入原Task持续上下文，Host拒绝时原Owner继续修正。

验收新增：相同模板创建两个任务，调整一任务不影响另一任务；删除不适用节点、修入参/产出合同、插依赖后原会话继续；成功步骤不重跑；重启恢复修改后的流程；实际原目标验收仍满足。

## 本轮 Owner 反馈实施合同

动作应用异常不等于业务任务结束。Controller 持久化 owner-action-failure 工件，保留原决定、原错误 message/stack/cause、owner-plan/owner-repair 收据及当前计划、执行节点、效果状态和证据引用。随后同一控制账事务封存该失败决定（discarded，不重发），通过 system.recovery 事件把诊断交回原 Owner。此路径以诊断工件为合同，不新增错误码白名单。无诊断的旧原生命令仍不能凭一个错误码扩大恢复权限。

discarded 只表示不再应用旧决定，不撤销已发生的计划或效果。下一回合必须从当前计划/回执出发：零应用可修参数，部分应用保留成功部分，未知效果先对账。暂停或取消时不调度新 Owner；所有修改继续原权限、来源、CAS 与 effects 门禁。Owner 读取工件并提出不同策略，现 repairCurrentStage 的 summary/evidenceRefs 继续注入原执行会话，不创建第三个监视会话。动态流程调整在同一 action 下附受管 workflowRevision，由 Host 的模板/原验收约束核验。

## 本轮实施合同（任务副本，不接收执行代码）

沿 Owner 既有 repairCurrentStage 增加 workflowRevision：startNodeId 指原未完成起点，checkProfileDigest 从 Host 当前仓库及同仓库已正式登记的检查配置中选；nodes 可提供完整新后缀，每项 nodeId/templateNodeId 指受信节点工厂，inputBindings 只引用同Task原requirement字段或前驱实际输出字段，inputSchema/outputSchema为数据合同。禁止模型函数、shell脚本及伪回执；原授权/输入身份字段不得被重绑。真实构建、业务验收和交付职责节点仍必须存在且保持受信能力，完成还走原业务验收合同。

registry按持久 taskRevision 重建任务独立定义并登记；controller.reviseTaskWorkflow({commandId,taskId,runId,expectedRevision,workflowId,workflowDigest,startNodeId,reason,evidenceRefs})调用领域validateRevision，再由worker原子核同Task/源/控制/原定义/CAS/排空及effects。成功前缀原样复用；已发生效果的后缀不能删除重派。副本历史、原定义与旧产物永久可查，不改全局模板。

工程读证明不再只依靠内存：对旧流程，从同Task/Run/gen的真实原生执行会话工具记录核path/hash及当前文件，重建缓存；无确切记录不声称已读，Owner可令原执行节点真实补读。历史记录只是读取事实，不创造业务授权。检查错误的归因交给Owner结合原日志/实际候选判断，不继续增加Maven或Node错误字符串门禁。

Owner 已 applied 后的后续推进错误保留 applied 状态，只追加完整 system.recovery 诊断；pending 决定停止应用并封存，二者均不回滚计划/效果。`resumeCurrent:true` 与 `settleManagedCandidate:true` 分别请求已公布的只读原节点续行和受管候选领域核验，二者互斥且不得同时带 nodes/checkProfileDigest；Owner 参数结构不代替 Host 的实际效果/原生读取证明准入。

本轮具体职责约束按可信模板角色核验真实检查、本地验收结果和交付；define/plan 等实现节点不是业务原则。零效果冗余 apply 可删除，后续 verify 仍冻结当前完整候选。nodes[].dependencyArtifacts 将原依赖 ID 绑定本 Run 同代 succeeded 节点 outputRef，Host 校验真实引用并将原工件提供给既有 mapper；不注入模型值。新副本持久 requestId/nodeRoles，最终交付证明回读原生修订收据，不能仅凭可疑 workflowId 前缀接纳。旧工厂和旧摘要不变。

### SG19 已有编辑后的方案纠正
真实原Run同代已有两次 succeeded edit，但随后 candidate-in-place 修复将 apply/verify 失效为 blocked，保留原编辑效果。新提案含 from===to 条目，纯 validator 正确拒绝；原 node.resume 却将审计保留的非零 lease 与编辑历史视作新执行，阻断原Agent纠正。只对匹配 Task/Run/generation/workflow/requirement 的原生 workflow.repair.accepted 审计，允许 blocked 且输入输出已按审计失效、lease 完全一致的后继继续保留；编辑例外仅限原 apply-changes 的全部 succeeded edit，并核旧成功输出与旧输入身份。未知、未完成或外部效果仍拒绝。恢复仅令原 inspect 会话纠正提案，现有完整候选树证明和后续真实检查不变；不删效果、不重放原补丁、不直接宣布业务完成。

Owner 的额外证据准入以当前 Task 快照绑定及本轮实际读取为准，不按修复 mode 限制原需求和阶段产物；system.recovery 应用失败工件还核对当前需求/计划/控制版本。旧 accepted blocked 决定经现有队列直接转诊断反馈，不再次执行旧动作；历史仅存错误码时明确记录缺失调用栈。nodes[].dependencyArtifacts 原依赖到实际产物引用由领域 Host 核验，不接受模型自行提供输出值。

恢复证据在 Owner 与执行合同使用同一当前 Task 阶段工件投影：必需失败诊断仍全部引用；额外可用原需求、当前阶段输出/诊断及当前 requirement/plan/control 版本的原生 system.recovery 反馈。反馈必须有真实事件登记和 owner-action-failure 身份，不能仅凭工件正文自称当前。领域查询的额外证明仍保留原验证；正常 Task 工件不再在后续准备票据被重复误拒。

本轮读取事实闭环：从原持久 Owner session 的成功 task_owner_read_artifact 原生 call/result 配对重建完整分页读取，历史输入限定同 Task/session/需求版本；只复用当前仍绑定需求/阶段的 SHA 工件，Host 重读并验证工件原值。重启不依赖内存 read mark，不新建读取账。候选拒绝身份包含本 turn 新增成功读取覆盖进度，重读相同正文不解除重复保护。workflow-revision 模式缺 workflowRevision 时在候选工具给出具体字段反馈，未接纳/未应用。

### SG22 本地验收重新规划的实际接线
原前端 Run 的 prepare-local-acceptance 冻结 mapper 从固定 define/plan 依赖读取场景和用例，并把 previousOutput 当已验证 build。仅插入新规划 Agent 或添加 inputBindings 不会改变该 mapper，甚至会把新方案误当 build；旧场景依然是其他任务的 review-opinion-draft。新增 nodes.dependencyBindings 将原声明依赖映射至同图前驱中相同受信模板职责及输出合同的节点；previousOutputNodeId 仅可选择原隐式前驱相同职责的实际输出。保留原 mapper、executor、effects 与输入校验，不接受模型 JS 或直接填 plan 数据。

localAcceptanceProfileDigest 仅选择 Host 已配置 taskLocalAcceptance 或本 Task 已登记且精确 scope 的配置，scope 包含 taskId、uatEnvironment、requestDigest(request+acceptanceCriteria)。无匹配配置就如实无能力，不能沿用同仓库另一业务场景或由模型提供 shell。新副本记录完整受信配置，成功 prefix 不变；原准备及原编辑不重放，真实验收职责仍必须存在。旧冻结定义不改变。

### Owner 观察与长执行恢复隔离（round 80）
现场 execution_events 已记录新的检查失败，但原 TaskOwner 队列仍停在旧失败；现有失败指纹已包含 lease、input 相关诊断，并非已证实的去重键缺陷。精确阻塞 await 未收敛，不按推测修改错误码或指纹。

复用现有 5 秒恢复入口，将 Owner observe/dispatch 置于独立 single flight，和执行计划推进/效果对账并行；消息 reconcile 移入消息恢复 flight。Resident 初始恢复异步记录结果，确保正常恢复 timer 得以注册。关闭先停止新恢复，再等待既有观察/执行/消息 flight 后关闭存储。health.executionStore.recovery 仅返回当前 lane 的 phase/taskId/since，无业务正文；空值表示该 lane 无在途恢复。此字段不参与 Owner 事件身份。

### 2026-10-09 用户收窄：固定流程与持久检查回执

取消模型运行时改图入口；已接受 taskRevision/checkpoint 的图与审计仍按原冻结定义恢复，不能改历史成功节点。SG20 当前 gen6 的原 planner session 提交 `{cases:[]}`，已具备正确 criterion/scenario，应由原 planner 接完整失败上下文补case；不是向用户提问或重启整Run。

prepare-commit 的重复构建来自工厂内存 verificationTickets 丢失。修复由 Host 在工厂恢复时读取当前Run成功 verify 节点的SHA工件、原input及对应登记定义，核同代/需求/候选及完整检查配置；校验Git候选及verification摘要后恢复模块可信票据，再用原工厂逻辑复用。旧execute/mapInput/rulesDigest不变，不以任意input.verification或相同check id/version单独授权。检查配置变化或无有效本Run回执不得复用。交付证明不再以适配重复检查掩盖该根因。

本轮收窄为固定流程与原执行者纠正：只继续 SG20，其余未完成任务用正式 pause，已完成任务保持；不通过动态工作流副本修改图来修复。原 plan-local-acceptance 对 prepare-local-acceptance 的真实 plan 输入负责：失败无效果且当前输入仍绑定原输出时，原 session 收完整诊断，修正后仅重新准备本地验收，中间成功节点和候选保持。原 controller/node.resume 事务保存诊断和版本，不新增状态机或 Owner 审批环节。未知外部效果不重发。

当前 repositoryInspect 搜索逐文件 git cat-file 导致数千次子进程启动。改为冻结OID的 cat-file --batch，按预计正文+header字节约4MiB分批，单大文件独立批；逐条严格OID/blob/size/hash及分隔校验，最后只返回原UTF8小写substring匹配的路径列表，offset/limit/total语义不变。历史workspace路径仍使用真实文件读取和原哈希校验，未拓范围。
