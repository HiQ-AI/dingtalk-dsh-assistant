# 看板交互合同

此文件记录 UI 后果，任务权限、CAS 和生命周期的实现来源是 packages/dingtalk-dsh-assistant/http.js、task-session-service.js、dynamic-task-store.js，真实 HTTP 合同见 test/http.test.js。

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Select/Listbox | DSH Menu / SelectMenu；设置与创建表单原生 select | DESIGN.md；observer web-client.js | 已有筛选使用宿主菜单；简单单选由系统拥有展开样式 | test/observer-slot-compatibility.test.js；浏览器 fixture |
| Form | CreateTaskForm / TaskControls 与共享 useUnsavedTaskChanges | http.js strict schemas | 新建；需求补充；应用内取消确认 | test/observer-node-control-display.test.js |
| Scrollbar | observerCss | DESIGN.md | 宿主内容区；局部有界结果区 | 静态审计；浏览器窄屏检查 |
| Toast | 页内 role=status / role=alert | 既有群消息设置与看板反馈 | 错误留在发生位置；提交成功状态 | test/client.test.js；组件行为测试 |
| CRUD | TaskSessionDetail / CreateTaskForm / TaskControls | http.js 与 task-session-service.js | 新建后进入唯一任务详情；需求更新留在详情；取消保留历史 | test/http.test.js；组件及浏览器 fixture |
| 人工请求正文 | HumanRequestContent / linkedTaskText / readout | docs/api/task-session-human-requests.md | 任务详情与人工介入页共用；原因与完整问题直接显示，证据/已尝试/原文折叠；不推断批准或缺失原因 | test/observer-node-control-display.test.js；真实浏览器 |

## 业务与安全来源

- 权限身份：HTTP 本机连接、可信 Origin、精确 Host 校验；模型或请求 body 不能传 actorId/sessionId/lease。
- 任务变更：需求与控制的 CAS，稳定 requestId 幂等键；陈旧请求显示冲突并保留输入。
- 数据生命周期：旧工作流、版本变量、绑定与固定运行操作返回 410。历史任务/输出/群消息仍只读可查，不做删除或恢复。当前动态任务仅新增本机受信归档：已完成或已取消，且任务会话、执行及效果均已结束时，在原动态账本记录 archivedAt/archivedBy，保留结果、材料与执行历史；不删除、不清理目录、不停止活动执行。旧工作流归档仍返回 410。
- 历史管理入口：话题协调/操作恢复、话题修复、维护变更与旧测试任务写入同样返回 410；维护状态仅有受信只读 GET，并标记 legacyReadonly。测试入站消息仍受 testApiEnabled 开关控制，普通群订阅与消息重试保留。
- 秘密及连接：资源连接/凭据服务保留在 Host 层；退役流程变量不构成向模型公开凭据的替代路径。
- 金融、计费、法律流程不属于此 UI。

## 流程与状态

创建：看板 → 表单 → strict HTTP 校验 → 任务详情。成功后清理草稿，失败保留字段和幂等键。重复点击不会重复发送。IME composition 不触发提交。

补充：详情 → 输入 → requirement/control CAS → 刷新同一任务会话。取消：详情 → 写明原因的应用内确认 → 使用确认打开时控制修订提交 → 历史仍保留。取消不会承诺撤销已发生的外部操作。

离开：新建和补充的脏状态触发页内确认；取消离开保留输入；真实页面卸载使用 beforeunload。新建页和详情保持自然滚动。

查询：自动/手动刷新共用请求；任务切换隔离过期响应；动态执行分页可重试并自动夹紧越界页码。看板通过 taskDTO.executionSessions 获得全部轻量会话投影，不依赖详情执行分页；按会话去重并以创建时间和执行 ID 稳定排序。执行名称由 dynamic-task-store 持久化并复用 session-workspaces 的原生清理逻辑，续办不重命名。新委派可在同次 task_delegate 调用中提供明确中文短title（技术专名可保留英文）；缺名或纯英文title沿用原key名称，不从objective截断或按动作词合成中文名，不另调用模型。key仍用于幂等，objective保留完整目标。续办不是改名操作，即使提供新title也保持已有名称。既有持久英文名称保持兼容，不在读取或续办时静默迁移；正式改名需另行协调台账与原生标题。读取状态合入独立执行标题槽，加载、失败和重试保留已读取列表及分页位置。空列表、正在读取、读取失败和旧数据可见状态不同。

导航：看板嵌入宿主 conversation 插槽，使用 sessionStorage 记住当前页，不占用宿主会话 URL。列表筛选/分页目前属于本次看板会话内状态；不把任务正文写入 URL 或持久客户端存储。

人工等待：任务详情读取当前 waiting-reply 申请的 reason/question/evidence/attemptedActions，与人工介入页使用相同正文组件。已有历史摘要不覆盖当前申请；缺少独立原因时明确显示未说明。全文范围保持可读，链接只接受 http/https，长文本可换行。显示层整理转义换行时不修改持久记录，申请原文可用键盘展开核对；完整申请不作为实时状态区反复朗读。答复表单及其幂等、失败保留、修订冲突合同不变。

验证边界：纯 fixture 浏览器可验证 UI 与真实 HTTP 的连接、失败、状态和键盘行为，但不代表宿主实际原生会话注册、模型、凭据、钉钉发送或线上部署已验证。

Agent 设置：名称、工作区、模型和代理沿用现有保存/刷新流程，不提供全局署名字段。回复署名由工作区及群职责决定；客户端不提交署名配置，旧客户端提交已删除字段时展示服务端错误并保留草稿。

归档：卡片右下角“归档” → 受信本机 HTTP → 动态账本事务 → 成功后更新对应任务并移入历史列表；失败显示 alert 且保留卡片，执行中拒绝归档并解释不自动停止。同步 ref 防重复，过期刷新不能把已归档卡片放回看板。归档当前展开项或刷新后该项已移除时清空 expandedTaskId，不重新默认展开；执行会话列表跨桶单展开，允许手动全部收起，首次数据到达后仅一次默认选择执行中按 updatedAt 降序的第一项。

归档后生命周期（本次用户选择的行为变更）：task.reopen/revise/control 与 task.claim/wake.claim 拒绝 archivedAt；任务/执行调度、后台恢复及话题协调候选列表尊重归档标记。陈旧话题动作在验证及实际应用时均拒绝归档目标；新消息需沿现有 new-task 路径创建/关联新任务。归档记录和显式历史查询仍可读，不新增恢复产品或全局工具门禁。

人工介入详情：原生模态 dialog 隔离背景，Tab 循环、Escape/关闭/遮罩点击关闭并恢复入口焦点；关闭仅关闭视图，不答复或处理申请。正文独立滚动，答复反馈预留位置；关闭重开沿用既有清空未提交答复行为。
