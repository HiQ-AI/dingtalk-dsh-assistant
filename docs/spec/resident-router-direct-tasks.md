# 常驻 Router 与直接任务路由

日期：2026-11-06；实施前快照。权威进度只在 `docs/acceptance/topic-routing-quality/goal.md`（SG8）。

## 目标与现状

按用户最新三点要求，退役当前运行时 Topic/Unit 中间业务层：一级只做处理/回复意图判断，消息直接关联 Task；每个真实群聊/私聊具有独立的逻辑常驻 Router，自主判断、安排和调整任务；Task 执行继续使用现有原生 Skill、工作区及记忆能力。Router 每轮结束且没有排队输入时总结必要连续性并换新物理上下文。

当前入口是 `resident.js` → `openTaskSessionService`，不是旧 `workflow-service.js`。当前 `topic-runtime.js` 先归 Topic/Unit 再按 Topic revision 决策，来源完成、任务动作与结果回流均依赖该层，仅改提示或隐藏看板不满足要求。`task.create` 已可保存直接 sourceRefs，但 service 必须验证来源身份与授权。旧 `group-coordinator-session.js` 仅由退役 workflow 链调用，其 resume/fork 复制历史，不是已生效的当前常驻 Router。

当前普通私聊不进业务 intake：all-direct 仅处理精确引用的人工答复；群入口还要求已订阅 group。须将真实私聊接入、类型隔离和发送回读一并接通，不能只构造内部 key。

## 方案比较与决定

1. 复用旧协调器并把 Topic 改名：旧 fork 继承全部事件，来源/效果仍经 Topic/Unit，排除。
2. 只使用 DSH 自动压缩或每轮 compactNow：本地 alpha.2 声明有维护锁/压缩接口，但不保证当前运行 profile 已加载；压缩不换物理会话，不能替代独立业务队列和必要安排持久化，排除为主实现。
3. 保留现有 DSH，以真实会话为逻辑 Router 身份，用现有持久决议账保存连续性和排队输入，轮末总结成功、队列/在途空后新建干净物理会话：采用。不新增 Agent 引擎、数据库或通用调度平台。

pi 官方具备 `session_before_compact` 自定义/取消总结、完成事件及 `newSession`（parentSession/setup）机制；应用仍须自行判断空闲、保留必要安排并处理竞态。只借鉴机制，不因用户提及 pi 迁移整个引擎。上游版本参考：earendil-works/pi，coding-agent 1.5.0，commit `4ffe32c6f1a138451162d6772f2723488fa32fad`；官方入口 https://github.com/earendil-works/pi/blob/4ffe32c6f1a138451162d6772f2723488fa32fad/packages/coding-agent/docs/extensions.md 。接口事实由平台成员核对；本项目代码只能调用本地版本可验证的 DSH API。

## 职责与契约

### 一级初筛

- 以当前可直接/快速取得的真实输入、职责和必要轻量会话信息判断；不拆事项、不遍历完整历史/Task，不安排任务。
- 每条固定来源提交明确 `needsProcessing` 与回复意图（静默或简短正文），允许“交 Router 且先简答”；没有处理/回复需要时不发送。
- Host 验证完整来源版本/批次与真实作者，保存稳定首筛 receipt；需处理的原输入持久投递对应 Router。不给首筛 Task 或业务副作用工具。
- 不继承逐 Topic 初诊、Topic 目录比较和 Unit 切分合同。简答不等于 Task 已接纳/完成，也不能覆盖历史实质结果。

### Router 与 Task

- Router 身份由真实 conversationType + conversationId 确定，不用显示名、标题或作者姓名。群与私聊分开；私聊不因接入就获得任意执行权限。
- Router 接收来源输入和 Task 的完成提案/结果、等待、阻塞、需输入等事实；按需查询完整来源、历史 Task、技能指引和回复候选。来源直接以 sourceId/messageId/version 关联 Task，不创建隐藏 Topic/Unit。
- Router 固定批次结构化提交任务意图、回复/静默、审阅结果和必要连续性，Host 仍唯一执行 Task 创建/补充/重开/取消、发信及送达回读。
- 来源在当前 surface 真实曝光后才能作为授权依据；大正文通过已有 model-content 机制按需完整读取，不把压缩摘要视为已读或授权。保留 Task requirement/control version CAS、preserve/replan、取消 owner 及自身通知围栏。
- 同业务目标内部阶段留在同一个 Task；真实独立事项才分别建 Task。跨 Task 的“A 完成后再 B”作为 Router 必要连续性与原始依据保留；B 尚未获条件满足时不先启动。Task Owner/执行的 Skill/原生权限/操作对账保持。
- execution.result、accepted、wait 或局部 idle 不算 A 完成。Router 必须审阅匹配版本的 Owner 完成提案/权威事实，结合 drain 与 unknown 效果状态判断；旧版本/重复报告不能重复启动 B，取消/重规划后不能沿旧摘要执行。

### 轮末总结与物理换新

- Router 结构化轮末输出同时携带简洁 continuity：尚有效的意图、先后/条件、未决判断及对应真实来源/Task 身份。不复制可查 Task 状态、完整消息、日志、附件、工具结果或目录。
- Host 在有效轮决议及其动作 receipt 稳定落账后，确认原生会话 whenIdle/Inbox 无 pending、业务来源/fact 队列空、无未应用动作/在途请求，再在同一会话锁内 CAS 换 generation；不能只凭 native whenIdle 认定业务空闲。
- 总结由本轮 Router 提交，不对不断增长的旧日志另做全量大压缩。落账/flush/轮换失败保留原物理会话与待办，不静默丢弃，不无界重试。
- 新消息/Task 回流与换代使用同一持久仲裁边界：换代前到达则继续原轮/排队，换代后到达则携新 generation 从已落 continuity 续办。已结束轮原始审计保留，不以 fork/seed 全历史冒充清空。

## 持久化与恢复

复用 Resident 现有群锁/CAS/决议待应用账，保存首筛处置、Router 队列、generation/lease/session 绑定、必要 continuity、冻结批次、动作计划及应用 receipt。Dynamic SQLite 仍为 source/Task/operation/notification 与 Task 事实权威账；不新增平行数据库。

公共职责面（具体 JS 参数由唯一写者共同定稿）：
- `triageAccept`：固定来源版本、静默/简答/处理意图与 Router 入队在 Resident 原子落账。
- `routerEnqueueFact`：真实 Dynamic fact ID 幂等投递。
- `routerClaim` / `routerCommit`：冻结 batch+generation/lease；提交时检查版本、曝光与审阅快照，原子保存决定、动作计划、continuity 和批次 ACK。
- `routerRotate`：与来源/fact 入队共用锁，检查无活动轮/队列/待应用后换代。
- Dynamic 直接来源处置终态：不再依赖 unit/routingRevision；来源已处理与 Task 业务完成分别投影。
- Task 事实先在 Dynamic 产生事务内持久化，再按稳定 fact ID 投 Resident，接纳后确认投影/消费；中断可续投同 ID。覆盖等待/阻塞/需输入/完成，不只读取现有 task.completed 事件流。

跨 Resident JSON 与 SQLite 不假设原子：先固定已接纳决定/操作身份，再用现有稳定 operation ID + 参数摘要执行；已有成功 receipt 只读回投影，unknown 沿原身份对账，不换 ID 重放。相同决议恢复不得重判或重发已送达消息。outbox 准备、Task 版本和真实来源许可在实际提交/发送边界重验。

## 旧数据与对外合同

- 不删除或重建旧 Task、归档 Task、来源、成功决定/operation/notification receipt、已送达消息和原生日志。
- 新路径不再写 Topic。旧 Topic/Unit 和旧 replyBindings 只作固定版本历史证据/一次性迁移输入，不继续承载新运行时路由；迁移不得按标题或最新来源猜身份/授权。
- 可核旧 Task 来源投为直接 sourceRefs/真实会话绑定；旧 pending 与 accepted 未投影事实按真实身份转成 Router 输入，已消费/成功事实不重放。旧未完成来源仅在无成功动作、或已完成原身份对账后沿新入口处理。证据不足显式阻断并保留原因。
- 配置迁移保留已选模型实际值，改为一级/Router语义；不更改已配置 provider/model/effort，不增双引擎开关。
- 看板/API/消息来源展示改为会话→消息→Task；移除当前 Topic 导航/操作/依赖，保留历史证据可读。不将状态计数下降当业务完成。
- 实施不修改正式实例或业务账，迁移仅临时隔离数据；PR #347 保持 OPEN，新分支基于14ad11aa，交付时声明依赖。没有合并、部署、CI、真实发信/重放或新付费评测授权。

## 单写与验证

- A：新直接 Router 协议/运行时、Resident store 的直接处置/队列/receipt/代次，相关单元测试。
- B：原生会话层、角色/工具绑定、持久会话身份、空闲换新与失败恢复，相关单元测试。
- C：Dynamic 直接来源终态/Task事实，task-session-service 的 Task 动作/回流/旧数据迁移，隔离 Host/存储/原生集成与 fixture。只改自身单写文件，确需共享文件先交接。
- Lead：DWS/bridge/Resident 私聊接入与发送回读、整合、Goal/spec、Git/PR；必要包清单与模型配置整合。
- D：独立只读审查实现/测试与安全反例，不预设主控方案正确。
- E：按已确认契约更新对外展示/API/说明及轮末归档，精确文件边界另行交接，不写 Goal 或主仓。

最小充分覆盖：轻量首筛静默/简答/处理（不拆事项）；直接消息-Task版本与跨会话隔离；A完后B跨换新/重启且不重复/不提前；轮换与新消息/fact竞态及总结/持久失败；旧任务/未投影事实/已送达receipt保全；普通私聊实际入口与精确发送回读；相关来源/授权/审阅/unknown反例；实际npm包与风险相关测试映射。旧Topic合同按明确退役点迁移/保留历史，不删除失败断言求绿；不无理由全仓重跑。测试绑定实际源码/工作树，真实模型措辞和平台送达未测则明确未验。

## 2026-11-09：Router 任务动作契约修复快照

现场来源#913已读到明确开发授权，但模型猜测update-task/task-update等未定义动作，随后空提交被当作语义完成，原已完成Task未续接。

- 采用：在既有Router模块定义严格动作Schema，用项目已有`toToolJsonSchema`同源投影给模型，明确new-task/task-context/task-reopen/task-cancel、CAS字段及任务状态语义。保留现有授权/完整来源读取/任务读取门禁。
- 拒绝给猜测动作加别名：不能由Host替模型选择需求变更、补充或重开语义，也不能隐式放宽CAS。
- 拒绝一律禁止空actions：静默讨论、事实回流或无任务变化的合法输入仍需允许。只在本批真实工具历史出现任务动作提交失败、其来源没有被本次合法动作/持久安排承接时阻断提交，持久记录可重试的Router失败，不把技术失败降级为空成功；不跨批次推断模型自然语言意图。
- 历史空成功不批量回放、不改库或倒写旧决策。修复部署后，先核对原Task及新近效果；仅沿现有Web同Task重开接口，以稳定requestId和最新CAS传入已核实的原授权及批准方案，保留旧审计与原Task身份。不新建业务Task，不为恢复另建迁移平台。
- 定向验证：真实原生工具可见Schema、错误任务动作后空提交必须失败且有恢复记录、正确同Task重开后实际Owner/执行获得新输入、重复提交不重复续接；保留合法空动作和群/私聊停用合同。部署按既有原生runbook，不触发CI/tag或真实钉钉测试外发。
