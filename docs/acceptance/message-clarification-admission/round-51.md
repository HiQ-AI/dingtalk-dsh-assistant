# Round 51：UAT2 审核页面受管取证

## 实现与定向验证

沿已有 `query_runtime_status` 增加固定 `uat-review-observation` 资源，没有新增 Task、浏览器会话管理框架或任意脚本/URL 参数。`agent-query-browser.js` 复用现有验收的测试账号登录、独立 headless Edge、Cookie 上下文及退出流程；业务 API 仅已核对的读取路径。模型只选 resourceId，Host 注册账号/Playwright/证据目录。页面只切换折叠按钮，拒绝撤回、分配、保存、消息已读、跨站请求与 WebSocket。

实跑：`node --test test/agent-query-browser.test.js test/agent-query-runtime.test.js test/agent-query-tools.test.js test/configure-agent-query-resources.test.js`，30/30 PASS，2.657s。包含正常读取、异常仍关闭/退出、不泄露凭据、已有statusIds权限、配置未知字段拒绝、业务写路径与跨站阻断、原K8s/数据库/文件查询回归。TEMP/TMP 指向本工作树 docs/tmp/authorization-state-tests。

## 真实环境观察

2026-10-08 20:08，分别使用已登记 hiqadmin 与 sunpeng 账号，在 UAT2 `/audit/dataset/received?tab=0` 真实登录。两者均实际显示9组菜单；折叠宽100px、展开240px，1440×1000窗口无横向溢出，实际截图已查看。最终请求阻断项仅 Google/阿里遥测脚本与生产 collect 埋点；未执行任何业务写入。首次白名单缺少 app-config/字典/reviewers/template 引发页面错误，已依据现有API源码补齐并重新运行，上述结论只基于复跑证据。

私有证据：`docs/tmp/sg19-browser/49769f3c-7a74-452f-bde9-24863cfc06db/observation.json`（admin）、`b635c5cd-569e-4789-ac35-a14ccbffc963/observation.json`（sunpeng），同目录initial/toggled.png。原图不入库。两个账号拥有完整菜单，不能据此宣称已复现仅审核角色的稀疏菜单问题；不修改真实账号权限来制造场景。原 Task 可以通过本能力获得当前账号的真实观测，但尚未部署/登记，不能宣称 Task 已恢复或完成。

## 撤回通知调查

正式只读数据库 capability 在只读事务内定位反馈过程对应1条申请 `5c1a03bf-71a4-48f2-abcd-b602600893fa`，当前PENDING、current_round=2、reviewers=null；有两次分配历史（13:05:04、13:10:19），均指向相同两位行业/LCA评审。证据 `docs/tmp/sg19-application-proof.json`。未改原申请或分配。

流式读取 UAT2 dataset 当前容器自13:10以来全部可用日志，41,321行/5,983,340字节，但实际最早18:58:39，最晚20:11:33；原13:20窗口已不在当前日志。目标申请、过程、消息发送失败/接收人为空/撤回模板均无命中，只证明这个保留窗口没有相应日志，不能证明历史已发送或未发送。证据 `docs/tmp/sg19-notification-log-proof.json`。管理员列表不能作为两位接收人的送达证明。此轮没有以代码推测替代实际复现，也未向反馈人重复索取已有信息。

PR363当前实读为OPEN，head=1cafb18181597efeb09c945a9b109abec14def6b、mergeCommit=null；未合并不是未部署充分证据。镜像→构建→提交的独立核验由主线程继续，当前不声称已部署或未部署。

最终正式 capability（非直接helper）真实 execute+verify：20:15附近，sunpeng账号，`verified=true`、`failedReads=[]`、`businessWrites=0`；折叠100/展开240。独立回读产物目录 `docs/tmp/sg19-browser/5e892f83-a606-4f64-a4ef-0deba4474fe6/`。此处是开发工作树真实UAT只读能力验证，不等于正式Host已部署。

### 同因补证：消息表确实存在

只读结构核验确认当前 hiq_editor/public 存在 `te_message`、`te_message_read`、`te_message_template`；旧独立消息服务的 ts_message 表名不适用于当前原生消息引擎，不能再声称该连接没有通知记录。使用相同受信UAT连接和只读事务限定同租户13:00–13:40得到6条APPROVAL消息。13:05:04与13:10:19的待审通知均投递给两位历史reviewer，记录未删除、未读。13:19:47与13:21:16为STATUS_CHANGE_START_USER通知，精确对应原申请LCA REVISION与行业APPROVED审核记录，不能当成撤回通知。撤回模板STATUS_CHANGE_REVIEWER存在且未删除，但该时间窗无此模板消息；这不能证明撤回接口已成功执行。证据 `docs/tmp/sg19-message-delivery-proof.json`、`sg19-message-columns.json`、`sg19-templates-proof.json`。不读取消息正文、不输出凭据。最小新增表列与browser资源登记片段已写 `docs/tmp/sg19-query-additions.json`，未应用线上。

## 最终收敛：撤回分配 outbox 在领取前 SQL 失败

重新读取原文和引用链后，相关操作应按“分配后撤回/撤回分配”分析。历史原话还包括“分配后打回修改撤回的问题”，与整份申请撤回、评审REVISION是不同路径，不能互相代替。部署前端提交 `d1e447787201212140a2732b798d336965ddfaa7` 的 `AuditRecordListDialog.vue:236` 调用 `/approval/assignment/withdraw`，不是 `/approval/withdraw`；按钮依据服务器 `row.withdrawable` 显示。主线程已用Pod/Registry/Woodpecker证明实际后端为 `fe42eb27028310392a239c29532db3255ddafeb6`，源码 `ApprovalServiceImpl.java:640` 及 `ApprovalNotificationOutboxService.enqueueWithdrawal` 表明撤回分配同事务写outbox，使用PENDING模板+`@i18n:approval.notify.assignment.withdrawn`变量；前段按STATUS_CHANGE_REVIEWER查撤回通知的推断不适用于此操作，现以本节取代。

原申请直接关联两条撤回outbox（非按时间猜测）：

| outbox ID | 分配 ID | 撤回入队时间（UTC+8） | 当前投递状态 |
| --- | --- | --- | --- |
| 6d8ea66d-7fb2-4393-9576-2bc13055ff78 | 6b41f678-615b-41e4-9409-5aa0ef5f56ff | 13:05:58.521 | PENDING，attempt=0，无delivered/error |
| f64a600a-e817-407d-8c6d-7eed488332b1 | 1f53dd12-2d7b-422c-ab53-ceddeac6bbc4 | 13:22:32.014 | PENDING，attempt=0，无delivered/error |

当前定时任务确实每10秒启动；18:58:39至20:27:03日志中 `selectDueForUpdate` / `BadSqlGrammarException` 各531次。实际SQL被重写为 `... next_attempt_time <= ? FOR UPDATE SKIP LOCKED ORDER BY create_time ASC LIMIT ?`，PostgreSQL明确报 `syntax error at or near "ORDER"`，入口为 `ApprovalNotificationOutboxTask.dispatchDueEvents:39`。源码XML原来ORDER在锁前。由此排除“调度未启动”和“接收人已收到但未读”为该两条事件当前未送达原因；失败发生在取事件之前，未进入attempt递增及发送逻辑。

修复方案只交付，不在本轮擅改业务仓：对该专用调度select跳过无作用的tenantLine重写，保留动态schema路由、排序/批量20/事务/FOR UPDATE SKIP LOCKED。部署版本TenantHandler.TABLE_NAMES本不含outbox，因此现有查询本来跨租户，没有要删除的tenant谓词。实施前须用实际MyBatis拦截器链+隔离Postgres验证最终SQL、并发不重复领取、失败重试/成功记账，其他租户查询不变；不要禁用全局拦截器。是否这一窄注解足以修复仍待该隔离验证，不宣称业务修复完成。

共享材料已写并独立回读：`D:/baibu-agent/tasks/task-5c4b495243ce147b3d6e32279fe9715f/work/uat2-assignment-withdrawal-diagnosis.json`，id/text/requirementRevision=2，3431字节，包含原两事件和脱敏证据。Owner可据此完成“继续核查”的原目标；不再泛化能力等待。本轮未发送通知、修改队列、创建测试申请或修改已有业务数据。配置增量 `docs/tmp/sg19-query-additions.json` 追加outbox必要列，供Owner用正式只读query独立核验，未线上应用。

## 追加：UAT2 原生隔离流程实际复现（21:04–21:11）

按原用户“自己去 UAT2 走一遍”完成实际流程。上节“未创建测试申请”仅对应较早只读阶段，本节为后续已授权的隔离验证；不把诊断代替流程复现。

复用现有 UAT2 登录和只读连接，新增本特性脚本 `scripts/reproduce-uat2-withdrawal.mjs`，原因是旧验收脚本固定 localhost/旧业务 ID，不能安全承载当前 UAT2 新对象。脚本绑定原 Task/req2、唯一 acceptance UUID、新对象名称和创建人；禁止重放已开始的执行。数据库读取均 BEGIN READ ONLY，无数据库写操作。

实跑命令均 exit 0（最终 verify 前修正一次辅助查询漏写 `$1` 参数，保留失败及成功重验时间，不重放业务动作）：

```powershell
node docs/acceptance/message-clarification-admission/scripts/reproduce-uat2-withdrawal.mjs --check --namespace acceptance-b7ce5e1b649740069ce2cb61eef7d624
node docs/acceptance/message-clarification-admission/scripts/reproduce-uat2-withdrawal.mjs --execute --namespace acceptance-b7ce5e1b649740069ce2cb61eef7d624
node docs/acceptance/message-clarification-admission/scripts/reproduce-uat2-withdrawal.mjs --check --namespace acceptance-b7ce5e1b649740069ce2cb61eef7d624
node docs/acceptance/message-clarification-admission/scripts/reproduce-uat2-withdrawal.mjs --cleanup --namespace acceptance-b7ce5e1b649740069ce2cb61eef7d624
node docs/acceptance/message-clarification-admission/scripts/reproduce-uat2-withdrawal.mjs --verify --namespace acceptance-b7ce5e1b649740069ce2cb61eef7d624
```

- 新过程 `c82ae299-ef12-4f95-9f2f-aea229f6c7e9`：原生复制、计算校验、计算完成、提交均 HTTP200/code200；原过程只读，前后指纹相同。
- 新申请 `ffe8ce94-4a45-4bba-9dd7-a850280fbce8`，新分配 `d6e6158a-b0e8-4204-b9e0-86c1423770c6`：hiqadmin 分配 sunpeng 为行业/LCA 两类审核后撤回分配，原生接口均成功；回读申请 PENDING、reviewers=null。
- 正常提交自动生成待审核站内通知，22 条收件记录；sunpeng 原生消息列表真实读到消息 `78d59c9d-df10-478e-97dc-863acba1c2d3`（21:04:54，未读）。没有手工发消息。
- 撤回 outbox `8e966a6a-661b-47f3-963a-89725076dd94` 已真实入队，收件人仅受控 sunpeng；21:11 独立回读仍 PENDING、attempt_count=0、delivered_time=null。复现“撤回后新通知未送达”，不宣称通知成功。消息列表仅首页100条，未送达判断同时有精确 outbox 和过程关联 DB 回读支撑。
- 清理先 check 精确新 ID/名称/创建人，再原生撤回新申请、原生删除新过程；独立最终回读申请 WITHDRAWN、processDeleted=true，原过程指纹不变。审核/outbox/站内消息审计保留；不删除数据库行、不手动派发队列、不操作原申请。

共享材料：`D:/baibu-agent/tasks/task-5c4b495243ce147b3d6e32279fe9715f/work/uat2-assignment-withdrawal-flow-proof.json`（id/text/req2），含步骤请求、HTTP结果、独立回读、清理边界。私有副本 `docs/tmp/sg19-flow-final-proof.json`。本轮已完成业务核查及实际复现；业务队列 SQL 修复仍是明确后续实施项，未修复或补发历史通知。

## 追加：Owner 独立收件视角补齐

领域验收工件 `16182526253b…` 指出文件自述不足以独立核实收件身份和清理。本轮仅扩现有浏览器只读资源：同一实际登录会话固定 POST `/api/dataset/message/list`，参数 `{messageType:'APPROVAL',pageNum:1,pageSize:100}`；返回 `messages.userId` 和每条 `id/msgType/sendTime/isRead`，不返回正文、变量或其他收件人信息，不新增模型参数。此为最近100条观察，不证明全历史缺失。

实跑上述四个 query/browser/config 测试文件，30/30 PASS。`node docs/tmp/sg19-independent-read.mjs` 最终 exit0：实际 sunpeng userId4306、100条、精确读到初始通知78d59c9d…；businessWrites0、failedReads空。独立只读事务确认实际表为 `public.tw_processes`（非te_process_map），原过程 is_deleted=false，新测试过程 is_deleted=true。最小登记提案 `docs/tmp/sg19-process-query-additions.json` 只含 id/name/is_deleted 三列及真实schema/readback证据；未在线应用。辅助查询首次显式uuid cast不匹配varchar已修为text，回滚后完整重验通过。

## 追加：历史操作回执来源闭环
原 files 查询只证明文件读取，未提供宿主执行来源；域校验将真实脚本逐步回执降为普通自述。本轮 files 可选 hostReceipts 精确登记，读取核摘要、完成核 Task/req，再给领域评审顶层 Host 来源，保留业务判断。定向 task-general-workflow/configure-agent-query-resources/agent-query-tools 三文件 52/52 PASS；覆盖篡改、跨Task、跨req、普通文件不升级、领域仍可拒绝。真实现有回执仅读取验证 nextOffset=null，登记增量 docs/tmp/sg19-host-receipt-binding.json；未重复任何业务操作，未线上配置或部署。
