# 技术方案与文件修改分离

## 目标与本轮边界

用户要求三个节点各司其职：编写修改方案产出可审阅技术文档（可含示意代码），检查修改方案核对需求、设计、范围和验证，按方案修改文件才读取当前文件并实施修改。方案不是逐项from/to清单，验收不能把计划当实现。沿一个Task、一个Run、同一共享目录完成，不增加人工审批或业务等待。

本轮只设计，不修改已冻结源码。先发布当前紧急修复，v19另行实现；不得直接改已持久化v18 factory源码。

## 当前实现与缺口（源码证据）

1. task-workflow.js:226、278：inspect-and-propose虽叫方案节点，prompt/outputSchema实际要求完整changes和精确replacements（path、expectedHash、from/to）。v11之后只在这个补丁对象上追加document，未分离职责。
2. task-workflow.js:347–360：validate-proposal是pure code，主要检查文档名称、正文长度、补丁路径是否在文档中；没有理解需求、设计一致性或验证充分性的能力。它能验证结构，不能等价于技术评审。
3. task-workflow.js:282–313：apply-changes是code。它冻结/读取当前候选、检查旧from唯一性后拼出全文，再调用editAdapter.prepare/perform；实际实现决策已经发生在前一模型节点。重复失败会重新生成整份实际补丁，导致歧义/过期基线与无变化漂移。
4. execution-session.js:296–353：execution_node_submit按节点outputSchema提交，通用工具registry已有binding/current/AbortSignal检查。不是必须把patch塞在第一个submit；可以给不同节点不同schema/tool集合。
5. execution-controller.js:72：目前agent节点只允许pure/read。第三节点若真正通过工具编辑，需要明确新增受限工程编辑能力，不能标成read却暗中写，也不能绕过网关直接开放原生shell/fs工具。
6. execution-edit.js已提供受管prepare/execute/reconcile，验证目录归属、文件hash、路径/链接安全；execution-delivery.js已提供效果身份、授权、资源排他、未知回执对账和同代增量身份。应复用，不再造编辑器或恢复账本。
7. execution-artifacts.js已有Task共享work/artifacts、work/materials-index.json和outputs的按Task索引。方案正文与节点工件可在这里共享，后续节点按ref读取，不逐节点复制正文、不新建Task级存储。
8. run.workflow.checkpoint现仅接checks/local-acceptance且固定v18、同节点executor。直接调用它不能合法把validator/code与apply/code改成agent。input.apply会新代，不是本需求的精确保留前缀迁移；需要明确新增窄迁移种类，不能伪装checks更新。

## 推荐唯一执行路径：v19三节点

保留ID，改变含义与版本；UI文案分别为“编写修改方案”“检查修改方案”“按方案修改文件”。

| 节点 | executor/能力 | 正常产物 |
|---|---|---|
| inspect-and-propose | agent/read，repo_inspect与Task共享材料 | 技术方案document：问题和证据、需求映射、设计/接口/数据变化、拟影响文件或模块、验证方法与风险；代码片段仅作说明，无changes/replacements/expectedHash要求 |
| validate-proposal | agent/read，可核原需求和实现 | 结构化设计评审：需求覆盖、设计可实现性、授权范围、测试覆盖、发现的问题及方案ref/digest；不是人工审批 |
| apply-changes | agent/read + 精确受管workspace.edit | 读当前方案、需求及实际文件后，用engineering_apply_edits实施；最终submit引用真实编辑效果和修改摘要，不重复提交技术方案补丁 |

方案产物仍由Host正常artifacts.put持久化，其document.markdown通过现Task共享索引可读；如需要可下载.md，复用现task artifact文件写出能力，引用同一正文工件，而不是另建平行版本库。评审和编辑输入只需当前方案ref/digest及Task上下文，实际正文按需读。方案后续修订有新ref，旧版仍可追溯。

检查节点必须真读需求与方案，必要时查源码。Host只校验输出结构、方案引用和范围；模型负责语义判断。结构错误在同会话纠正。明确设计问题回到原方案节点修订，保留准备前缀与历史方案；不向用户追加确认，只有真实缺需求/权限才使用原业务输入机制。此反馈复用现node恢复合同的精确前驱纠正，需扩展到方案评审的拒绝结果；不能用异常无限重跑。

### 编辑工具的最小合同

新增唯一工程受信工具engineering_apply_edits，仅v19的apply-changes可见。binding、Run、目录、授权来自Host，模型不能指定这些身份。模型参数仅是本轮文件修改（读取所得expectedHash、完整新内容或精确局部替换）；Host复用已有原文唯一性/实际当前hash/路径限制及managed-edit adapter。局部替换是实施手段，发生在编辑节点，不进入技术方案数据契约。

优先采用一次有边界的文件批次：编辑agent按需读完当前文件再调用一次本轮apply；读取或参数错误返回可纠正结构化结果，未发送前可修改参数重试。成功后同一binding只回读原effect；需要新的业务修改由正式原地修复创建新input/审计，不凭随机tool-call ID重复写。未知效果先reconcile，绝不换ID重发。该约束复用现网关的一次派发身份，避免新增通用多步编辑事务体系。

必须在controller的agent允许效果列表和工具registry两处显式绑定workspace.edit；只给此工具，拒绝任意shell/write工具。Host工具调用进入相同delivery.execute；最终execution_node_submit只接受与当前binding、方案ref相符的真实成功effect引用/或经完整树证明的无新增修改，不能靠模型文本声称改完。后续verify-candidate冻结实际完整树、构建与业务验收一律保留。

## 执行候选比较

1. 保留第一个agent产补丁，仅把document字段改名：排除。实施决策仍提前，未满足用户要求，也不能消除旧from歧义。
2. 给编辑agent原生不受限文件/命令能力：排除。绕过目录/hash/效果对账，原unknown重启无法证明是否重复修改。
3. 新增“生成补丁”agent和第四个应用code节点：技术可行但不选。能复用现只读agent契约，却增加用户未要求节点，三个节点仍不能直接对应职责。
4. 三节点+仅编辑agent的Host受管工具：推荐。真正读取当前文件并编辑，方案与补丁分离，保留现效果/共享目录/验证能力，无新审批或Task。

## 旧活动Run迁移：窄v18→v19定义检查点

候选A新Task/新Run重跑：排除，丢失原工作进度并重做成功准备。候选B改v18函数或持久digest：排除，破坏所有历史恢复身份。候选C新generation从头input.apply：排除作为默认，容易重新创建workspace并要求重放完整旧补丁。候选D原Run/原generation精确suffix定义迁移：推荐，无新schema；由现checkpoint原子CAS扩展一个明确plan-execution迁移分支。

- 新Task直接登记v19；旧终态Task不迁移，历史定义继续恢复v18。
- 只有真实仍需修改、处于稳定等待并已排空的工程Run才迁移；不要为了“换架构”让已成功业务验收的任务重新跑。
- 保存原Task/Run/gen、workspace、成功prepare前缀；旧方案、节点输入输出、native session、effect回执保持可查。迁移审计引用这些旧身份，禁止删除effects或伪称旧节点未执行。
- 从inspect-and-propose起重算技术方案/评审/实施，invalidate必要后缀：旧验证不能被当作新编辑后的验证。真正未受影响的前缀逐项身份不变。
- 可以保留相同nodeRunId并变更当前定义的version/executor，但必须保留旧绑定历史和清理已排空旧session绑定；schema现UNIQUE(run,node,generation)不支持同代插入同ID第二行。新agent会话必须按新定义创建，不resume旧只读方案或旧code伪session。
- 仅允许已有成功workspace/edit且完整当前树可证明；未决效果或已经发生本地环境/commit/push/PR等后缀外部效果时不能套用此早期迁移。相应任务继续旧流程，或另作具体不重复效果的迁移设计；不得静默重放。
- 后续编辑效果必须关联正式迁移审计和已有成功edit，以新input形成增量身份；现effect.edit-repair只识别candidate-in-place，需显式承认这一次受管迁移的同等审计事实，不能伪造历史repair事件或绕identity guard。
- 复用现requirement/control/source/definition/CAS和维护排空，不加真人审批。参数固定fromVersion18/toVersion19和受影响节点集合，不做任意workflow迁移器。v18前缀与新v19前缀的字节契约需实测相同，不能仅名字一样就保留。

## 实施文件边界与验收

- task-workflow.js：新v19 factory及三节点schema/prompt；v18原文不改。
- workflow-engineering.js：v19登记/恢复、方案共享引用、受管编辑工具接线与窄迁移记录。
- execution-session.js：工具registry接工程编辑能力，submit收据校验，已知参数错误同回合纠正。
- execution-controller.js / execution-store-worker.js：精确agent编辑许可、评审纠正、原Run定义迁移CAS及成功前缀保留；不新增通用调度图。
- execution-delivery.js / execution-effects.js：沿用一次编辑网关；只补迁移审计作为增量身份来源（若最终复用原正式repair产生的新input可避免新增来源，但不能假造旧事件）。
- execution-artifacts.js原则上复用不改；Observer按新节点产物展示文档/检查结果/实际修改，不能仍把第一节点当patch summary。

必须验证：第一节点无补丁也可提交真实技术文档；第二节点能拒绝设计缺陷并原Task修订；第三节点先读当前hash、实际文件字节发生预期变化、重复工具不重复写；校验失败不重做准备。另验真实旧Run副本迁移、成功前缀/effects原样、旧v18恢复摘要不变、未排空/有外部效果/来源漂移拒绝。最终仍以实际业务验收及Task完成事实交付，不以新结构注册成功算完成。

## 未收敛点

上述为源码支持的可实施最小方案，尚未实现/测试。apply agent最终submit引用效果的精确schema、旧Run迁移中executor/version更新所需审计字段及语义评审回到方案节点的最少恢复参数，需在实现前用真实fixture校准；现成工具没有直接满足这三处，不能宣称只改prompt即可。

补充交叉核验：execution_node_submit原生参数始终为当前节点冻结schema的output（execution-session.js约295），无需按节点ID新增submit工具。旧Run受影响节点的新input envelope必须引用v19 workflowDigest；仅改Run digest或复用旧input会被Controller身份校验拒绝。迁移细节与三任务选择参见engineering-checkpoint-recovery.md末尾v19预研：SG18/SG20仅在确需业务修复时从方案节点重算，SG22已通过的前三节点不可为升级而重跑。工具桥暂不传native exec.callId；本方案单批受管编辑不依赖新增callId身份，若以后真实需求要求多批，必须另行定义效果身份与未知效果恢复，不能随机改ID避冲突。

## 用户最新收敛：取消独立方案检查节点

2026-10-09 用户提出检查节点是否可以去掉。最终实施调整为 v19 两节点：inspect-and-propose 只产技术方案；apply-changes 先核方案与当前代码，再以受管工具实施。此前三节点推荐不再作为最终实现。独立 validate-proposal 不进入 v19 定义，旧 v18 定义及历史输出保留。

方案自检包含需求覆盖、设计可行性和验证方法；实施 agent 结合实际代码核对。确有设计错误且尚无编辑效果时，提交具体修订问题，复用原任务的前驱纠正回到方案节点，保留成功准备；不向用户追加审批，不新建任务。当前版本已成功的业务步骤不为了架构升级重跑。修改后的 verify-candidate、构建检查和业务验收继续核真实实现。

## 集成时发现的既有等待恢复缺口

v19 两节点测试通过后，只读检查三条原运行发现：SG18 的 no-additional-change 修复已有可信证明执行器，但普通恢复扫描不会重新进入该确定可恢复节点；SG22 必要依赖决定 accepted/blocked 不进入 pending 应用队列，单发诊断无效。当前集成分别增加完整树证明后的原 Run 续行，以及既有 task.owner.retry 的精确未应用 insertDependency 重评。两者不修改旧工厂定义、不删除成功编辑、不创建新 Task，不扩通用暂态重试名单。恢复决策由当前来源、控制、输入、已排空和真实效果账共同核验。
