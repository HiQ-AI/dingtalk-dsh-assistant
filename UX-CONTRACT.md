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

## 业务与安全来源

- 权限身份：HTTP 本机连接、可信 Origin、精确 Host 校验；模型或请求 body 不能传 actorId/sessionId/lease。
- 任务变更：需求与控制的 CAS，稳定 requestId 幂等键；陈旧请求显示冲突并保留输入。
- 数据生命周期：旧工作流、版本变量、绑定与固定运行操作返回 410。历史任务/输出/群消息仍只读可查，不做删除或恢复。
- 历史管理入口：话题协调/操作恢复、话题修复、维护变更与旧测试任务写入同样返回 410；维护状态仅有受信只读 GET，并标记 legacyReadonly。测试入站消息仍受 testApiEnabled 开关控制，普通群订阅与消息重试保留。
- 秘密及连接：资源连接/凭据服务保留在 Host 层；退役流程变量不构成向模型公开凭据的替代路径。
- 金融、计费、法律流程不属于此 UI。

## 流程与状态

创建：看板 → 表单 → strict HTTP 校验 → 任务详情。成功后清理草稿，失败保留字段和幂等键。重复点击不会重复发送。IME composition 不触发提交。

补充：详情 → 输入 → requirement/control CAS → 刷新同一任务会话。取消：详情 → 写明原因的应用内确认 → 使用确认打开时控制修订提交 → 历史仍保留。取消不会承诺撤销已发生的外部操作。

离开：新建和补充的脏状态触发页内确认；取消离开保留输入；真实页面卸载使用 beforeunload。新建页和详情保持自然滚动。

查询：自动/手动刷新共用请求；任务切换隔离过期响应；动态执行分页可重试并自动夹紧越界页码。看板通过 taskDTO.executionSessions 获得全部轻量会话投影，不依赖详情执行分页；按会话去重并以创建时间和执行 ID 稳定排序。执行名称由 dynamic-task-store 持久化并复用 session-workspaces 的原生清理逻辑，续办不重命名。读取状态合入独立执行标题槽，加载、失败和重试保留已读取列表及分页位置。空列表、正在读取、读取失败和旧数据可见状态不同。

导航：看板嵌入宿主 conversation 插槽，使用 sessionStorage 记住当前页，不占用宿主会话 URL。列表筛选/分页目前属于本次看板会话内状态；不把任务正文写入 URL 或持久客户端存储。

验证边界：纯 fixture 浏览器可验证 UI 与真实 HTTP 的连接、失败、状态和键盘行为，但不代表宿主实际原生会话注册、模型、凭据、钉钉发送或线上部署已验证。
