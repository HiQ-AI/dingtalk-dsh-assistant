# 流程编排、节点契约与可靠中转实施方案

日期：2026-09-22。基线：83fc504596f0faff4c65f92991a444ea13f6af5a，插件版本 0.5.15，存储 domain v8。

本文是实施前设计快照。当前只交付方案；文中的字段、状态、脚本和验收目标除明确标注“已有”者外，均为拟实施内容。没有据此修改运行时、迁移真实存储或部署。

## 1. 目标、范围与路线选择

目标：任意一个流程节点都能回答“读取了什么版本、承担什么职责、产出了什么、谁核验过、下一步由谁推进、失败后从哪里恢复”；在此基础上减少无效模型调用、无效重做和等待占槽。

完成标准：

1. 工具声明、Host 校验和持久化契约具有明确的共同来源，节点通过有身份、有版本的持久化产物交接。
2. 业务验收、任务执行、通知投递分别记录结果，不能用一项成功代替另一项成功。
3. 接收、提交、派发、回读等边界发生故障后，恢复不重复已确认的业务动作；无法确定的动作先对账。
4. 阶段、验收项、产物和证据能够关联；旧版本证据可审查复用，不能通过改版本号冒充新证据。
5. 每个等待和失败都有责任方、解除条件、有限恢复路径以及可观察的状态。

| 路线 | 判断 | 原因 |
| --- | --- | --- |
| 继续主要靠提示词约束，补少量校验 | 排除 | 无法保证重启中转、错误归属和执行资源释放；提示词不能代替存储提交 |
| 引入通用工作流引擎，并为每个节点创建 Agent | 排除 | 当前主要缺口在现有节点间的契约；新增运行时、迁移和模型调度成本缺乏收益证据 |
| 沿用 Host + Topic + Task + 报告队列 + Outbox，逐步收紧契约 | 采用 | 已有版本校验、幂等身份和恢复基础，能按可验证的边界独立交付 |

保持单进程 Host 编排和 DSH 原生 Agent/Goal/Session 能力。插件固定通用流程；具体业务流程继续来自带版本的 workflow 配置。第一版 Task 阶段仍顺序执行，不引入通用 DAG 执行器或跨进程分布式锁。

通用标准不绑定某个用户、机器目录、特定 skill 或 goal.md 文件名；只要求交接记录可持久保存、可追溯。部署、数据库、代码仓库等资源标识由任务及当前环境配置提供。

## 2. 当前依据与需要补齐的边界

以下是基线代码事实；风险分析不等同于已经观察到线上事故。

| 当前事实 | 代码依据 | 实施处理 |
| --- | --- | --- |
| 已有按请求隔离的协调会话和同群模型串行 | coordination-sessions.js:21、:66 | 复用生命周期，调整公平性和排队观测 |
| 报告已持久化，重复 submissionId 会检查内容摘要 | task-reports.js:113 | 保留身份和去重机制，统一回执语义 |
| 报告回执 accepted:true 与 status:rejected 可以同时出现 | task-reports.js:5、:24 | 显式区分收件、审阅、应用和投递 |
| 完成审阅要求 notification；完成提交后异步写 Outbox | topic-runtime.js:110、:1008；runtime.js:975、:989 | 验收与通知独立；完成记录和通知意图同次持久化 |
| 未识别的报告异常默认进入 rejected | task-reports.js:59 | 系统错误不能伪装成业务不合格 |
| 已接纳 Decision 的操作失败会再次定时恢复 | topic-runtime.js:589、:623 | 增加有限重试、未知结果对账和明确阻塞态 |
| 等待审阅会 block Goal，但并发数仍按 Task running 计算 | runtime.js:1542、:1934、:1966 | 引入实际执行许可，统一恢复入口 |
| 新报告结构由 Zod 投影；审阅工具的 review 仅声明 object | task-result.js:107；topic-runtime.js:976 | 审阅工具也由同一 Zod 契约生成 |
| 验收项、阶段、证据以字符串为主，已有 stageId 基础 | task-result.js:30、:87；store.js:156、:158 | 扩展为可关联的结构化产物，保留历史事实 |
| 未归类群消息会阻塞决定接纳，完成前还有版本和来源检查 | store.js:641；topic-runtime.js:1029、:1213 | 保留未知输入安全边界；先改善分类、公平性和无关输入处理 |
| 任务表把 completed 映射为所有阶段完成 | task-sheet-sync.js:24 | 区分成功、取消和历史未知结果，同步所有消费者 |

已有的报告去重、完成审阅恢复、发送前后回读、原生会话隔离不能在重构中丢失。源码路径均相对 packages/dingtalk-dsh-assistant/。

## 3. 整体编排与节点职责

主链：接收 → 材料准备 → 事项归类 → 业务决策 → Host 接纳并派发 → 计划确认 → 阶段执行与核验 → 完成验收 → 通知生成 → 投递回读。

旁路：补充输入进入版本修订；取消进入控制流程；信息缺失进入等待；系统失败进入恢复队列。它们都不能通过伪造“阶段完成”回到主链。

| 节点 | 唯一职责及执行者 | 输入 | 必须产出 | 放行条件 |
| --- | --- | --- | --- | --- |
| 接收 | Host 保存原始事实并去重 | 渠道事件、真实发送者与引用 | messageId、sequence、messageVersion、原文来源 | 持久化成功才交给后续节点 |
| 材料准备 | Host 确定性整理已授权材料 | 消息、引用、资源标识 | material manifest、缺失项、分页与完整性 | 缺失或预算不足必须显式表达 |
| 事项归类 | 模型识别语义单元及 Topic 归属 | 固定材料快照、Topic 索引 | unit/source ranges、Topic 关系、唯一归属 | Host 检查覆盖、来源、冲突与版本 |
| 业务决策 | 模型判断回复、新任务、补充、取消等意图 | 已归类输入、任务和 workflow 索引 | decision proposal、原文依据、预期版本 | 不在此直接创建任务或执行外部动作 |
| 接纳与派发 | Host 提交业务操作并驱动执行 | 已校验 proposal | decisionId、operationId、Task、派发回执 | 重查授权、版本、保留冲突及取消状态 |
| 计划 | 叶子制定本轮可验收计划 | 当前目标、workflow 原文和材料 | criteria、stages、证据复用及例外依据 | 结构检查通过，必要的语义审阅通过 |
| 执行 | 叶子完成当前阶段 | 当前计划、执行许可、批准的作用域 | 阶段产物、工具回执、阻塞项 | 依赖已满足；新副作用符合授权和版本 |
| 核验与审阅 | Host 校验事实，模型审查语义覆盖 | 产物、验收项、独立检查结果 | 检查结果、逐项审阅结论、缺口 | 所有必需项通过或有获准的例外 |
| 通知生成 | 模型或模板形成待发内容 | 已提交的业务结果、收件与引用范围 | notification draft | 内容、对象、引用和替换关系独立校验 |
| 投递 | Host/DWS 发送并回读 | 已持久化 Outbox | deliveredMessageId、回读证据或未知状态 | 回读确认后才标记已送达 |

这些是逻辑职责，不要求十个 Agent 或十个服务。同一模型调用可以生成“审阅结论 + 通知草稿”，Host 必须分别解析和提交，通知草稿格式错误不能抹掉有效业务审阅。

拆分函数的标准是独立输入、独立输出和独立失败恢复；不按文件长度机械拆分。优先在现有模块内提炼纯函数。

## 4. 参数与中转契约

### 4.1 公共字段的所有权

| 字段类别 | 生成与校验者 | 规则 |
| --- | --- | --- |
| requestId / decisionId / operationId / submissionId | Host；部分提交允许调用者提供幂等键 | 同身份同内容返回原结果；同身份不同摘要必须报冲突 |
| groupId / taskId / sessionId / node kind | Host 从已绑定请求取得 | 模型提供的标识只能作为核对值，不能用来改变作用域 |
| inputVersion / runSequence / planRevision / workflowRefs | Host 保存预期值 | 调用者回传版本后仍需比对；失效不得换上最新版直接重试 |
| sourceRefs / artifactRefs / criterionIds | 模型从当前可见集合选择，Host 校验 | 来源、版本、群、任务及可访问范围必须一致 |
| attempt / nextRetryAt / recovery status | Host | 重试保留原业务身份；不因换 attempt 产生新业务动作 |
| authorizationRefs | Host 绑定授权事实 | 模型不能声明自己已获授权；授权范围不从摘要猜测 |

公共 envelope 只保存实际需要的公共字段，节点 payload 使用有区分标记的具体 schema；禁止把所有节点塞入一个任意 JSON 对象。大文本和二进制使用带版本、摘要、读取完整性的引用；正文读取按请求绑定。

### 4.2 回执不再用一个 accepted 表达全部结果

报告接收回执示例，字段为建议契约：

~~~json
{
  "contractVersion": 2,
  "submissionId": "report-...",
  "taskId": "task-...",
  "received": true,
  "reviewStatus": "pending",
  "applicationStatus": "pending",
  "nextAction": "wait-for-resolution"
}
~~~

- received 只表示已保存；格式或身份不合格直接返回结构化错误。
- reviewStatus：pending / approved / rejected / stale / failed。
- applicationStatus：pending / applied / superseded / blocked；在 Host 完成状态变更后更新。
- 投递是独立 receipt：notificationIntentId、outboundId、deliveryStatus、deliveredMessageId；报告不假装知道所有投递结果。
- 对外状态由这些事实投影得出，UI 不能把 received 或 approved 显示成“任务完成”。

调用方、叶子提示词、原生工具测试和 Web/API 消费者在同一批更新；不保留两个含义冲突的 accepted 字段长期并存。历史事件可以只读解析，活动旧会话必须在契约切换时停止并重新绑定。

### 4.3 四道校验

1. 调用模型前：校验材料来源、读取权限、版本、完整性、上下文预算和该节点是否仍需要运行。
2. 模型提交时：Zod 结构校验，再检查引用、阶段依赖、验收覆盖、作用域和业务语义。
3. Host 提交或外部动作开始前：重新比对版本、取消信号、授权、资源冲突与幂等记录，避免检查后状态变化。
4. 外部动作之后：独立回读目标状态，区分 confirmed / failed / unknown；进程退出码和工具成功回执不自动等于业务结果成功。

schema 复用现有 toToolJsonSchema。review 按请求类型选择具体 schema，Host 再按绑定类型解析；模型不能通过选择另一个 discriminator 绕过当前节点规则。

## 5. 节点产出与验收证据

建议新一轮的 plan 作为唯一权威计划，现有 stageTasks、remainingItems 等展示文字由投影生成，不再同时维护两套完成清单。

~~~text
Plan
  revision, workflowRefs, sourceRefs
  criteria[]: criterionId, description, sourceRefs, verificationPolicy
  stages[]: stageId, title, criterionIds, dependsOn, expectedOutputs

StageOutput
  stageId, planRevision, inputVersion, runSequence
  artifactRefs[], evidenceRefs[], blockers[]

Evidence
  evidenceId, producerKind, sourceRef, observedAt
  subject: artifact/version/resource identity
  checkerId/checkerVersion when deterministic
  outcome: pass | fail | unknown | not-applicable

Review
  requestId, expectedVersions
  items[]: criterionId, evidenceRefs, verdict, reason
  exceptions[]: requirement, authorization/source refs, reason
~~~

关键约束：

- criterionId、stageId 创建后不因标题微调改变；删除后保留历史，不复用旧 ID 表示新事项。现有按标题形成 ID 的路径需要随之调整。
- 第一版 stages 顺序执行；dependsOn 只允许引用前序阶段。支持关系检查，不增加并行阶段执行器。
- 一个阶段可以覆盖多项验收，一项验收也可以依赖多个阶段；完成审阅必须给出每项必需验收的证据或正式例外。
- 模型自行声明的“检查通过”标为模型陈述；只有已注册检查器的真实执行回执才能构成确定性 PASS。
- UNKNOWN 不能被空字符串、无异常或缺少检查器转换成 PASS。NOT_APPLICABLE 要求具体依据，由适用 workflow 和授权边界决定是否成立。
- 文件证据记录摘要；外部资源记录可复查的版本或读回标识。敏感凭据只使用引用，日志和计划中不保存密钥。
- 新输入仅改变无关信息时，Host 形成影响清单；保留仍适用的证据身份并重新审阅。业务写入不因报告过期被重新执行。
- 授权收缩、目标变化、资源版本变化可能使旧证据失效；按受影响验收项传播，不按整个 Task 无条件清零，也不默认全部可复用。

验收链固定为：原始要求 → criterion → stage → artifact/evidence → check → review。任一环缺失必须能够定位到具体项。

## 6. 持久化中转、重试与取消

### 6.1 持久化产物后才能通知下游

统一顺序：计算候选结果 → 验证 → 保存结果与后续意图 → 返回持久化回执 → 派发下游 → 记录下游回执。

不假定跨 Task、Group、DSH Session 存在分布式事务。使用当前存储的单记录更新保存业务提交与后续意图，再用稳定身份幂等落实到另一记录或 Session。

完成路径具体调整：

1. 完成审阅只审业务目标、证据和授权；可携带独立通知草稿。
2. 一次 Task 更新同时保存 completed outcome、结果版本和 notificationIntent。即使没有有效草稿，也要保存待生成通知的意图。
3. 恢复器扫描未完成意图；校验或生成草稿，使用稳定 outboundId 写入现有 Group Outbox。
4. Outbox 写入成功后再记录意图进展。中间崩溃时重复 append 必须命中同一个 outboundId。
5. 已发但回执丢失先走现有发送回读；查不到不代表确定未发送。未知状态不得创建新身份绕开去重。
6. 通知恢复期间 Task 若被重新打开或版本改变，旧意图标为 superseded，或按明确策略生成历史事实通知；不能把旧结果当成当前完成状态发送。

Task 完成与 DSH Goal complete 也按相同规则恢复，不能因为 Session/Goal 更新失败重复业务执行。通知故障保留业务完成事实，并独立显示“通知待处理”。

### 6.2 错误归属和重试预算

| 类别 | 状态与责任方 | 恢复原则 |
| --- | --- | --- |
| 参数/契约不合法 | invalid；调用者 | 返回字段路径和约束，不自动提交同一坏请求 |
| 业务证据不足或验收不通过 | rejected；叶子 | 给出 criterion/stage 缺口，只补相应工作 |
| 输入/计划/workflow 版本失效 | stale；Host 与叶子 | 保留历史，做影响分析并生成当前版本的新提交 |
| 等待输入/授权/资源 | waiting；明确的持有者 | 写出解除条件，条件未变化不重复请求模型 |
| 可证明可重试的暂时性失败 | retryable；Host/对应适配器 | 使用同一业务身份有限重试 |
| 确定性故障或未分类异常 | system-blocked；Host/维护者 | 保存错误码和关联身份，停止业务自动推进 |
| 外部动作结果不明 | reconciling；动作适配器 | 先回读对账，无法确认则 blocked，禁止盲目重放 |

插件负责的本地操作重试初值：总计最多 3 次（含首次），两次间隔 2 秒、10 秒并加小幅抖动；实际数字通过故障测试和基线调整。attempt、nextRetryAt、lastError、恢复责任保存到现有 operation/coordination 记录。DSH 已负责的 provider 请求重试不再在外层叠加；DWS delivery 继续由自己的适配器负责。

部分 operation 已应用时不能重放整个 Decision，也不能释放尚未核对的冲突占用。阻塞只限制相关 Task/资源的新冲突动作；状态查询、对账和已授权取消必须有可达路径。明确未应用且已失效的操作才可由 Host 终结并释放占用。

恢复入口复用现有 retryTaskReport、retryCoordinationRequest，校验角色、版本、前次结果和原 operation 身份；“人工重试”也不能改 ID、绕过未知状态或刷新授权。

### 6.3 取消与外部副作用

- 保留 Task 生命周期 state，增加结构化终态 outcome：succeeded / cancelled / failed / legacy-unknown；等待系统修复不自动变为 failed 终态。
- 取消先持久化 stop-requested 和授权来源，阻止新的业务步骤；执行中的不可中断动作需要回读。
- 确认叶子停止且相关动作已对账后才标 cancelled。已产生的部署、消息、SQL 变更不宣称撤销；确需补偿时生成单独、获准的动作。
- 取消控制要经过与普通操作相同的来源与权限校验，但不能被该 Task 自己的失败 reservation 永久挡住；在存储串行区中使旧操作失效并保留其对账记录。
- 普通 shell/网络工具目前不是统一副作用事务网关。结构化计划只能改进追踪；要宣称特定外部动作可强制拦截，必须把该动作的所有执行路径纳入受控适配器和工具权限，并有绕过反例测试。

### 6.4 对已接入动作实施精确的资源占用

对实际接入的部署、数据库或文件写适配器，增加 ActionIntent：actionId、task/run/input 版本、adapterId、规范化 resourceKeys、参数摘要、authorizationRefs、status、receiptRefs。状态为 prepared → executing → confirmed / failed / unknown；unknown 只能进入对账流程。

- 在 Host 的短串行提交区检查资源占用，保存动作意图后才发起外部调用；调用和回读期间不持有全局 JavaScript 串行锁。资源占用状态仍保留，约束同资源的其他写动作。
- 全部资源键一起申请，冲突时一个也不占，防止两个动作各占一半相互等待；资源键由适配器正规化，不能相信模型为同一资源起的不同名字。
- 复用 Task executionEvents 保存动作事实，内存索引由事实重建，不新增数据库或独立锁服务。重启未终结动作先对账；不能仅靠超时释放 unknown 动作的资源占用。
- 只阻塞有冲突的受控写动作，独立资源和只读检查继续运行。别的进程和未接入工具不受此机制约束，需要外部系统自身提供版本条件、锁或幂等能力。
- 第三批先交付动作协议、Host 门禁与故障测试；真实适配器从只读盘点确认的高频动作开始接入，逐项证明回读和绕过防护后再声明覆盖。未接入范围明确记入验收报告。

## 7. 可以提前由脚本承担的工作

原则：无语义歧义、可独立复核的工作前置；脚本失败产出结构化诊断，不把整个脚本 stderr 塞回模型让其猜测。热路径直接调用模块，不为每条消息启动 CLI。

| 能力 | 实施位置与复用 | 产出与边界 |
| --- | --- | --- |
| 材料引用、附件状态、完整性和预算 | coordination-context.js、coordination-resources.js | 版本化 manifest；只取已授权、需要的资源，不递归预抓所有外链 |
| 引用集合、版本差异、受影响阶段 | decision.js、task-input-revision.js | affected criterion/stage IDs；不做语义归类替代 |
| 计划合法性 | task-result.js、runtime.js | ID 唯一、引用存在、无依赖环、验收覆盖、workflow 修订有效 |
| 环境预检 | 复用当前 workspace、worktree 与工具探测能力 | 必要工具/目录/权限是否满足；不运行会变更环境的安装或修复命令 |
| 确定性验收检查 | 新增 task-checks.js，小型检查器注册表 | checkerId + 结构化参数 + 独立结果；不执行模型提供的任意命令字符串 |
| 存储契约预检 | 扩展 scripts/check-resident-storage.mjs | 元数据、schema/引用问题、丢字段检测；--check 零副作用 |
| 通知准备和投递 | 现有通知构造与 dws-adapter.js | 简单确认可用模板；动态总结保留模型；所有发送经 Outbox |
| 恢复和归档预检 | 报告队列、操作恢复、task-worktree-archive.js | 待办意图、动作回读、可清理资产清单；清理仍需原有归属和安全检查 |

第一批检查器只做已在本项目发生、可只读核验的检查，例如注册产物存在及摘要、已登记命令回执与预期一致、版本化资源读回。Git/CI/部署等检查由适用 workflow 指定，不强制所有 Task 执行。

task-checks.js 新建的理由：检查器由 Host 执行且为计划、阶段、完成三个节点共享，不能混入模型提示词或 DWS 传输模块。材料与预算函数优先复用现有模块。迁移 CLI 单独新建，避免把既有 v6/v7→v8 工具悄悄改变用途。

## 8. 调度及性能优化

### 8.1 执行许可与业务状态分离

- maxConcurrentTasks 约束实际运行叶子的执行许可，不能继续简单按 state=running 计数。
- 等待审阅时先设置 step gate，再在叶子停止当前步骤、没有在途工具调用后释放许可；不能在工具仍运行时提前释放。
- 审阅结果先持久化并排入恢复队列；获得许可、重验版本及阻塞条件后再 resume Goal。notify、补充输入、重启恢复、监督器不得各自直接 resume。
- 协调模型保持独立调度容量，防止“叶子占满许可、审阅无法运行、叶子又等待审阅”的循环等待。
- 重启时不信任持久化的 active 标记，先冻结新派发、核对现有执行和未知外部动作，再重建许可。第一版限定单 Runtime 写同一存储；多进程不是本次支持目标。

### 8.2 公平性与输入中转

- 对 route 批次冻结输入快照，限制单次材料量；同群协调队列增加 aging，避免连续 route 插队使已排队的审阅长期没有模型机会。
- 初始调度规则可取“连续最多 2 个 route 批次后，服务一个已就绪的最老非 route 请求”；批大小及阈值经压测确定。这里的就绪仍受来源、版本和输入门禁约束。
- 任务已知无关 Topic 的新材料不应失效其验收；关联按明确的引用/Topic/Task 版本判断，不靠文本相似度偷偷放行。
- 第一版保留未归类输入对相关副作用和完成提交的保守阻塞。不直接删除 store.js 的群级 pending 检查来换吞吐；分类积压超过处理能力时，必须暴露积压和等待原因。
- 后续若要改为更窄的输入边界，必须先单独定义“接收、归类、控制意图生效、提交”之间的顺序语义，并用同批取消/授权收缩反例证明；未通过则保持保守门禁。本期不承诺持续过载下的无等待完成。

### 8.3 优化顺序及指标

1. 先消除无效调用：同版本确定性失败不反复调用模型，过期请求尽早终止，恢复复用已落盘审阅。
2. 再缩小材料：共享材料快照、按段分页、增量差异；缓存键包含内容版本、workflow 修订、权限范围，不能只用 URL 或 taskId。
3. 再减少等待占槽、改善 route/review 公平性。增加并发不作为第一手段。
4. 仅在 profiling 显示存储扫描/事件体积成为瓶颈时优化索引和保留策略；不得先裁掉唯一恢复证据。

复用 performance.js，增加按 request/submission/operation 关联的 queue wait、review wait、permit wait、reconcile wait、stale counts、重复模型调用与通知延迟。现有观测缺失要继续标注 coverage，不能将缺失 token 或未回读消息当作零成本/已送达。

比较协议：固定一份脱敏回放集，覆盖单任务、多任务、持续群消息、材料过大、取消和故障恢复；对同一模型配置分别运行基线与新实现。负载使用实测基线输入速率的 0.5×、1×、2×，至少三轮。分别报告正确率、p50/p95 等待、模型调用/token、队列增长和峰值内存，不用平均响应时间掩盖饥饿。

可直接验收的目标：通知重试新增业务执行次数为 0；同一提交恢复新增已批准审阅次数为 0；全部叶子恢复路径的实际并发不超限；未知结果重复写入次数为 0。模型调用下降比例和线上 p95 改善幅度在基线采集后确定，本方案不虚构性能收益。

## 9. 存储演进与回退

本方案包含结构化计划、完成意图和恢复状态的持久化语义变化，建议集中做一次 domain v8→v9 升级。domainVersion、工具 contractVersion、Task inputVersion、planRevision 各司其职，不混用。

1. 第一批仅做契约投影、错误分类及不改变持久化格式的调整；第二批再切换 v9。不能声称旧 v8 Runtime 能安全写回 v9 字段。
2. 新建 scripts/migrate-workflow-storage.mjs，复用现有迁移器的“停写源 + 独立目标 + 排他生成 + SDK 回读 + 源摘要不变”模式；--check 不创建文件、不调用 DWS、不创建 Session、不执行 Task。
3. 历史终态记录保存原始验收文字、报告、回执与来源；不得伪造 criterion 与证据的一一映射，不把所有旧 completed 推断成 succeeded。无法证实的结果标 legacy-unknown。
4. 活动 Task 生成稳定候选 criterion/stage 标识及原文字段映射，旧报告保留为历史。未能验证映射、存在未知副作用或部分提交的 Task 进入明确的 migration-review 等待，不自动继续叶子。
5. 活动任务经当前流程重新确认计划，可引用原有有效证据；不能因为迁移要求重做已发生的业务写入。歧义需要用户或维护者确认，迁移脚本不做语义猜测。
6. 历史只读投影是明确的读取边界，新写入统一采用 v2 契约；不建设长期双写/双执行模式。旧活动会话在停机窗口关闭，恢复时重新绑定当前工具契约。
7. 已发 Outbox 和业务操作身份原样保留；缺乏精确映射的旧完成结果不能自动补发通知，防止把迁移变成历史消息重放。
8. 同批升级 store、Runtime、observer、task-sheet-sync、导出及监控投影，保证取消不算成功、等待审阅不等于实际占用许可、旧记录可读。

真实切换按现有 docs/ops/topic-storage-migration.md 的停机与回退原则，在实施时补充 v9 runbook。先验证一致性副本，正式窗口保存代码、配置、存储与匹配 Session 检查点。部署前必须有明确授权，本方案不执行真实迁移。

回退边界：新版本尚未写业务状态或发生外部动作，可恢复匹配的旧代码、旧存储和 Session；发生新动作后须保存新介质、对账并确定处理方案。恢复旧 JSON 不能撤销外部动作，也不能在未对账时启动旧程序重放。无法安全降级时停止新派发并前向修复。

## 10. 六批实施与交付物

每批作为独立可审阅变更，前一批相关验收通过再进入依赖它的下一批。预估工作量为实施与本地验证 16–25 个工程日，另加真实环境观察窗口；这是基于当前源码的规划估算，不是已确认工期。

| 批次 | 具体修改 | 主要文件 | 验收门槛 | 估算 |
| --- | --- | --- | --- | --- |
| 1 契约与错误 | review schema 投影；回执分层；业务/系统/stale 错误分类；冻结基线用例 | topic-runtime.js、task-result.js、task-reports.js、tool-schema.js、runtime.js | 原生工具声明与解析一致；未知错误不判业务拒绝；旧版本不能推进 | 2–3 日 |
| 2 计划与存储 | 稳定 criterion/stage IDs；结构化证据与历史读取；v9 迁移；所有消费投影 | store.js、decision.js、task-result.js、task-input-revision.js、task-sheet-sync.js、observer；迁移/检查脚本 | 历史不丢失；歧义不猜测；源文件不变；取消不计成功 | 4–6 日 |
| 3 可靠中转 | 完成与通知意图同写；幂等派发；有限操作恢复；取消控制与结果对账 | runtime.js、topic-runtime.js、task-reports.js、store.js、dws-adapter.js | 每个提交间隙故障均可恢复；不重放已确认操作；unknown 不盲重试 | 4–6 日 |
| 4 脚本前置 | 材料 manifest；计划预检；小型只读检查器；证据引用校验 | coordination-context.js、coordination-resources.js、task-result.js、新 task-checks.js | 脚本不扩大授权；缺材料和 UNKNOWN 不变 PASS；同版本可复用 | 2–3 日 |
| 5 调度优化 | 统一执行许可；审阅释放/恢复；队列 aging；分段指标 | runtime.js、coordination-sessions.js、task-report-step-gate.js、performance.js | 原生 DSH 恢复不越过 gate；不超并发；取消仍可达；输入门禁不退化 | 2–4 日 |
| 6 分层验收与切换 | 固定集对比；SDK/进程故障测试；隔离迁移；获准环境业务验收及观察 | test/、docs/acceptance/workflow-orchestration/、docs/ops/、README | 用例与真实渠道分别留证；回退演练通过；观察指标无新增异常 | 2–3 日 |

第一批的边界是契约、回执和错误语义；不同时修改并发、数据格式、真实 profile 或部署。这样第一批异常可定位，第二批迁移也不会混入调度行为变化。

依赖顺序为 1 → 2 → 3 → 4 → 5 → 6。第一批可独立发布；第二至第五批分别审阅和验证，在隔离存储中联调后作为同一 v9 发布候选切换，不在真实 profile 上逐批试写未完成的 v9。第二批确定该发布所需持久化字段和历史读取边界；后续新增字段若改变旧代码写回安全性，必须重新审查版本边界，不能只在同一 domainVersion 下悄悄扩展。

每批更新实际涉及的 README/接口说明；spec 保留为开工前快照。实施证据归档到 docs/acceptance/workflow-orchestration/：plan.md、matrix.csv、round-N.md，跨轮脚本放 scripts/；全部必需项通过后才写 report.md。多轮实施时在该目录维护唯一 goal.md 与 sub goal matrix，具体业务任务本身不强制使用该文件名。

## 11. 必需验收矩阵

| ID | 场景 | 必须观察到的结果 |
| --- | --- | --- |
| C01 | 非当前请求/session 提交，或引用其他群资源 | 拒绝且没有 Task/Outbox/外部副作用 |
| C02 | 同 submissionId 同内容重复；同 ID 不同内容 | 前者回原结果；后者明确冲突 |
| C03 | 工具 schema 的每个审阅分支 | 原生 ToolRuntime 与 Host 同意或拒绝同一有效/无效样本 |
| C04 | 接收成功但审阅拒绝；系统未知异常 | 显示不同状态；系统异常不让叶子误做业务返工 |
| C05 | 输入、workflow 或 plan 在审阅中变化 | 原提交不推进；保留历史；只重验受影响项 |
| C06 | 授权收缩与取消在计划/执行边界发生 | 新动作被阻断；不能通过更新版本或重试绕过 |
| C07 | 阶段重命名、插入、删除、依赖错误 | 身份稳定；非法引用拒绝；旧证据不错误归属 |
| C08 | 模型声明 PASS、缺少产物、检查器 UNKNOWN | 不能满足要求独立核验的验收项 |
| C09 | 无关补充与已完成业务写入 | 保留有效证据；业务写入计数不增加 |
| R01 | 决定接纳后、Task 写入后、operation 回执前分别故障 | 同一业务身份恢复，Task/操作不重复 |
| R02 | 完成保存后、意图转 Outbox 前后分别故障 | 完成事实保留；最终只有一个有效通知身份 |
| R03 | 已发消息但确认响应丢失 | 先回读；没有确认不得标 sent 或换 ID 重发 |
| R04 | 一个 operation 永久失败且另一个已经 applied | 有限重试后阻塞；不重放已应用动作；取消与对账入口可用 |
| R05 | 取消时外部命令仍在执行 | 先 stop-requested，回读后给真实结果，不宣称回滚 |
| R06 | 通知草稿非法或投递失败 | 不推翻业务验收，不重复叶子执行；通知单独恢复 |
| S01 | 并发上限为 1：A 等审阅、B 就绪、A 获批 | A 安全让出许可，B 可运行，A 重新排队；任何时刻不超限 |
| S02 | 审阅恢复、补充输入、监督器、重启同时唤醒 | 每个 Task 最多一个执行许可，不发生旁路 resume |
| S03 | 持续 route 输入、已排队 review、混入取消 | 满足公平策略；不跳过未知输入或取消门禁；过载可见 |
| S04 | 相同已声明写资源的两个动作 | 第二个冲突写等待；无关资源和读取不被全局锁住 |
| M01 | v8 副本转换为 v9，重复运行和故意损坏输入 | 源摘要不变；排他目标；非法/歧义记录有明确阻塞 |
| M02 | 历史完成/取消、未结操作、旧会话和已发 Outbox | 不伪造成功、不补发历史消息、不继续旧工具契约 |
| M03 | observer、任务表、API 同读一个任务 | 结果/等待/投递状态一致；取消不显示验收全通过 |
| P01 | 固定回放集与 0.5×/1×/2× 负载 | 有基线及三轮结果；正确性不退化，等待与成本可解释 |
| E01 | 获准测试环境的真实引用、@、附件与发送回读 | 分场景独立证明；不能用 mock 或 HTTP 200 替代 |

S04 只对已纳入受控适配器、能够精确标识资源的动作承诺；任意 shell 的隐含资源冲突仍是盲点。第一版不以“所有叶子写操作都已经受控”作为未经验证的结论。

测试层次：纯函数契约测试 → 真实存储 SDK → 原生 DSH 生命周期 → 独立进程故障恢复 → 获准测试渠道业务 E2E。mock 抛异常不能完全代表进程中断或磁盘持久性；后两层须独立留证。

现有相关测试入口包括 test/task-result.test.js、test/task-reports.test.js、test/task-input-revision.test.js、test/topic-runtime.test.js、test/store.test.js、test/coordination-sessions.test.js、test/coordination-native-lifecycle.test.js、test/dws-adapter.test.js、test/task-sheet-sync.test.js、test/performance-runtime.test.js。优先在这些文件增加对应场景；迁移和进程故障测试在现有文件确实不适配时才新增。

本次分析已运行的基线命令如下，5 项通过；它只证明选中的现有行为，不是本方案实施后验收通过：

~~~powershell
node --test --test-reporter=spec --test-name-pattern='已建 Task 后故障|协调重试状态跨重启|settled后通知失败|完成审阅重启恢复|同群模型串行' test/topic-runtime.test.js test/store.test.js test/task-reports.test.js test/coordination-sessions.test.js
~~~

## 12. 上线前仍需收敛的事项

- 生产存储后端及对应 SDK 的故障持久性：当前已有 JSON 后端迁移规程，不能泛化到未经验证的后端。单记录提交与断电恢复能力需真实 SDK/进程测试确认。
- 真实活跃任务数量、历史歧义、未知副作用与待发通知数量：只读盘点后决定停机窗口，不根据源码猜测迁移耗时。
- 外部动作受控范围：先枚举实际使用的部署、数据库和文件写入方式，再选择接入适配器的范围；未接入路径必须在覆盖报告中可见。
- 群消息负载、模型响应与 token 基线：现有观察不足以给出确定收益比例，第二阶段以实测确定目标。
- 更细的跨 Topic 输入屏障：本期保持保守规则；只有顺序语义和取消反例收敛后才单独实施缩窄。

这些不阻止先完成第一批契约和错误治理；它们是存储切换、外部动作保证及吞吐承诺的前置条件。
