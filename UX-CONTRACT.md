# 看板交互合同

此文件记录 UI 后果，任务权限、CAS 和生命周期的实现来源是 packages/dingtalk-dsh-assistant/http.js、task-session-service.js、dynamic-task-store.js，真实 HTTP 合同见 test/http.test.js。

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Select/Listbox | DSH Menu / SelectMenu；设置页原生 select | DESIGN.md；observer web-client.js | 已有筛选使用宿主菜单；简单单选由系统拥有展开样式 | test/observer-slot-compatibility.test.js；浏览器 fixture |
| Form | TaskDialogue / HumanRequestReply / 既有设置表单 | http.js strict schemas | 对话与人工答复防重、失败保留输入；Web 无新建任务表单 | test/observer-node-control-display.test.js |
| Scrollbar | observerCss | DESIGN.md | 宿主内容区；局部有界结果区 | 静态审计；浏览器窄屏检查 |
| Toast | 页内 role=status / role=alert | 既有群消息设置与看板反馈 | 错误留在发生位置；提交成功状态 | test/client.test.js；组件行为测试 |
| CRUD | TaskSessionDetail / archiveTask | http.js 与 task-session-service.js | 查看现有任务、会话、结果与执行；符合条件的任务可归档；Web 不提供任务新建入口 | test/observer-node-control-display.test.js；test/observer-archive-interaction.test.js |
| 人工请求正文 | HumanRequestContent / linkedTaskText / readout | docs/api/task-session-human-requests.md | 任务详情与人工介入页共用；原因与完整问题直接显示，证据/已尝试/原文折叠；不推断批准或缺失原因 | test/observer-node-control-display.test.js；真实浏览器 |

## 业务与安全来源

- 权限身份：HTTP 本机连接、可信 Origin、精确 Host 校验；模型或请求 body 不能传 actorId/sessionId/lease。
- 任务变更：需求与控制的 CAS，稳定 requestId 幂等键；陈旧请求显示冲突并保留输入。
- 数据生命周期：旧工作流、版本变量、绑定与固定运行操作返回 410。历史任务/输出/群消息仍只读可查，不做删除或恢复。当前动态任务仅新增本机受信归档：已完成或已取消，且任务会话、执行及效果均已结束时，在原动态账本记录 archivedAt/archivedBy，保留结果、材料与执行历史；不删除、不清理目录、不停止活动执行。旧工作流归档仍返回 410。
- 历史管理入口：话题协调/操作恢复、话题修复、维护变更与旧测试任务写入同样返回 410；维护状态仅有受信只读 GET，并标记 legacyReadonly。测试入站消息仍受 testApiEnabled 开关控制，普通群订阅与消息重试保留。
- 秘密及连接：资源连接/凭据服务保留在 Host 层；退役流程变量不构成向模型公开凭据的替代路径。
- 金融、计费、法律流程不属于此 UI。

## 流程与状态

创建：Web 不提供新建任务按钮、菜单、空状态入口、快捷操作或新建表单/页面分支。钉钉消息等非 Web 创建能力以及共享后端创建 API 保持不变；这是 UI 能力调整，不是 API 权限变更。

现有任务：看板进入任务详情，保留原生会话入口、结果、执行列表与返回看板；“对话”展开当前任务的原统筹对话，不提供直接修订或取消控件。自然语言先持久保存、再沿原任务 wake/claim/lease 队列逐条处理，运行中不另起统筹；普通工作唤醒保留待后续处理。原统筹复用既有语义判断：询问进度直接答复，不广播执行反馈；仅 preserve 范围内的补充/方向纠偏可使用原 executionId 的 feedback，真实目标/授权变化须澄清，不调用 replan、续办、取消或新派。人工答复、归档及历史只读查询沿用现有流程。

对话发送采用 requestId 幂等，失败和未知结果保留原草稿及请求身份，重试不重复；消息、原文作者、回复与时间持久落账并可回读，回复和对应 wake 确认同一事务提交。收起重开保留当前任务草稿，切任务按 taskId remount，过期 GET 不覆盖已保存消息或已回读回复。IME composition 不提交，发送中同步防重；已结束、暂停、归档及旧历史不能发送，不自动恢复任务。保存只表示已接收；进入执行步骤仍须原反馈消费证据，不等于业务完成。原生会话输入和 Host 写入保护不变。

导航：移除仅供新建草稿使用的离开确认与 beforeunload 接线；任务详情保持自然滚动，其他表单沿用各自既有行为。

查询：自动/手动刷新共用请求；任务切换隔离过期响应；动态执行分页可重试并自动夹紧越界页码。看板通过 taskDTO.executionSessions 获得全部轻量会话投影，不依赖详情执行分页；按会话去重并以创建时间和执行 ID 稳定排序。执行名称由 dynamic-task-store 持久化并复用 session-workspaces 的原生清理逻辑，续办不重命名。新委派可在同次 task_delegate 调用中提供明确中文短title（技术专名可保留英文）；缺名或纯英文title沿用原key名称，不从objective截断或按动作词合成中文名，不另调用模型。key仍用于幂等，objective保留完整目标。续办不是改名操作，即使提供新title也保持已有名称。既有持久英文名称保持兼容，不在读取或续办时静默迁移；正式改名需另行协调台账与原生标题。读取状态合入独立执行标题槽，加载、失败和重试保留已读取列表及分页位置。空列表、正在读取、读取失败和旧数据可见状态不同。

导航：看板嵌入宿主 conversation 插槽，使用 sessionStorage 记住当前页，不占用宿主会话 URL。列表筛选/分页目前属于本次看板会话内状态；不把任务正文写入 URL 或持久客户端存储。

人工等待：任务详情读取当前 waiting-reply 申请的 reason/question/evidence/attemptedActions，与人工介入页使用相同正文组件。已有历史摘要不覆盖当前申请；缺少独立原因时明确显示未说明。全文范围保持可读，链接只接受 http/https，长文本可换行。显示层整理转义换行时不修改持久记录，申请原文可用键盘展开核对；完整申请不作为实时状态区反复朗读。答复表单及其幂等、失败保留、修订冲突合同不变。

验证边界：纯 fixture 浏览器可验证 UI 与真实 HTTP 的连接、失败、状态和键盘行为，但不代表宿主实际原生会话注册、模型、凭据、钉钉发送或线上部署已验证。

消息内容下固定一行展示已处理时的判断原文与处理历时，长文省略并保留 title 和可访问原文，未处理和缺失记录保持相同行高。不新增详情。`/state/groups` 从当前消息版本关联的已完成 Topic 判断取 `decision.reason` 或 `decision.reply`，以覆盖该归属版本的首个完成判断 `updatedAt` 为截止，多话题取最后完成者；不读取后续任务或通知回执，不取当前 Topic 的元数据更新时间。无话题的忽略消息用已有 ignoredRanges.reason 与收敛时 agentDeliveryAt；缺少证据明确未记录。历时起点为原 occurredAt，包含排队、等待和重试；负值或缺失不置零，不随页面刷新增长。历史 workflow-v2 记录缺少同源投影时明确未记录，不借用当前 Topic 数据。当前状态、筛选、原文和已有详情入口保留。

Agent 设置：名称、可选群回复署名、工作区、模型和代理沿用现有保存/刷新流程。署名可保存、清空及刷新回读；失败保留草稿，切换Agent后缺失配置显示空值。最终落款由Host负责，中间消息不追加，模型不负责署名。配置契约见 docs/spec/generic-agent-identity.md。

归档：卡片右下角“归档” → 受信本机 HTTP → 动态账本事务 → 成功后更新对应任务并移入历史列表；失败显示 alert 且保留卡片，执行中拒绝归档并解释不自动停止。同步 ref 防重复，过期刷新不能把已归档卡片放回看板。归档当前展开项或刷新后该项已移除时清空 expandedTaskId，不重新默认展开；执行会话列表跨桶单展开，允许手动全部收起，首次数据到达后仅一次默认选择执行中按 updatedAt 降序的第一项。

归档后生命周期（本次用户选择的行为变更）：task.reopen/revise/control 与 task.claim/wake.claim 拒绝 archivedAt；任务/执行调度、后台恢复及话题协调候选列表尊重归档标记。陈旧话题动作在验证及实际应用时均拒绝归档目标；新消息需沿现有 new-task 路径创建/关联新任务。归档记录和显式历史查询仍可读，不新增恢复产品或全局工具门禁。

人工介入详情：原生模态 dialog 隔离背景，Tab 循环、Escape/关闭/遮罩点击关闭并恢复入口焦点；关闭仅关闭视图，不答复或处理申请。正文独立滚动，答复反馈预留位置；关闭重开沿用既有清空未提交答复行为。


## 任务统筹模型配置

沿用设置页原生表单、既有间距与宿主主题。模型/推理深度通过 Agent 唯一保存入口保存；深度区分继承默认、模型默认及指定值。能力请求忽略过期响应；保存失败保留草稿并显示错误，成功可见反馈；保存期间禁止重复提交。刷新不得覆盖尚未保存的草稿，保存前的过期刷新不得覆盖成功结果。窄屏不出现横向滚动，原生控件保留键盘焦点。配置影响下一轮正常创建/恢复，不中断活动轮次。

模型配置布局：默认处理、统筹、协调模型各与“推理深度”同排，共用 Agent 配置卡片及相同两列宽度。统筹与协调共用 IndependentModelFields 与能力请求逻辑，原生 select/datalist 仍允许系统拥有菜单外观。协调独立持久化且默认 astra/轻度；统一保存先完整预检，再沿原顺序写入和分项回读。失败保留三行草稿，过期能力响应/刷新不可覆盖新状态。协调保存不改变 enabled，也不提供启用开关；新选择仅下一次规划采用，活动规划和动态 cwd 合同保留。窄屏按字段组顺序折行，共用唯一 Agent 保存入口与反馈。

两个深度标签均为“推理深度”，统筹未配置时默认轻度low，显式继承仍兼容。统一保存先预检再顺序写两个既有存储，写失败回读说明各部分结果并保留草稿，禁止虚称原子回滚或盲目重试。
