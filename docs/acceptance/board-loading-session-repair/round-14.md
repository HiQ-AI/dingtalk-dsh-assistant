# 第十四轮：插件审批私聊真实闭环

## 结论

原 #857 插件审批已实际私聊送达孙鹏，独立 mget 和完整私聊记录确认只有一条；原生事件仅一条 delivered，当前 decision=pending、通知 waiting-reply。恢复派发后的重复核验仍为同一消息，无重新建单、代替真人批准或执行生产 SQL。

## 根因与修复

补齐异步原生待审列表、原生任务投递路径和生产审批私聊身份/引用校验。沿现有 execution_events 保存冻结通知、发送意图、openTaskId 和实际消息回执，Web 与私聊共享首个决定。暂停、取消、重启及竞争均校验当前运行，不以 unknown 许可重发。

真实首发被平台拒绝：156字符 UUID 超过128上限。幂等键改为82字符冻结摘要，发送前预检；旧请求仅凭同一摘要绑定的精确1001拒绝和真实 trace 登记 unsent，再恢复原请求。随后消息已发送，但钉钉 mget 把软换行转成空格，确认比较失败；现在仅归一这项显示差异，保留其他空格、SQL和标点，回读原 openTaskId 登记原消息，不重新发送。

## 实跑证据

- `node --test test/dws-adapter.test.js test/dws-bridge.test.js`：77/77，含实际换行显示、SQL空格/表名/分号篡改拒绝、引用批准/驳回、未知发送防重及 Web 竞争。
- `execution-effects`：30/30；原生通知持久化、生命周期与精确负回执恢复。
- `workflow-service` 定向：10/10，真实 SQLite + 服务 + 桥接覆盖 UAT、重建及数据变更批准/驳回，身份/引用错误、维护恢复和暂停恢复。
- HTTP/Observer：57/57，含投递待确认展示和真实事件回调；工作流审批及数据变更外部链18/18。
- 普通无历史备份部署 PowerShell16/16，事件索引部署专项15/15。
- `scripts/verify-private-approval.mjs` 独立读取 API、只读 SQLite、DWS mget 和完整私聊：pending/waiting-reply、occurrences=1、health=ok、maintenanceActive=false。同一消息跨新进程确认，重复核验保持一致。

## 正式运行

Assistant 包 SHA256 `b6fd6e953630b4bed1325b1bf5d62482f23a13d324d1724e8adedebec05cc365`，100文件独立一致；Observer 包 `f9a02940510ab1bc0bdc2819eb157eb6ab1c024860b6b89cb7982710ec6d160e`，4文件一致。fresh PID17008，排空 Check、安装、独立 Readback、Resume 均完成，历史 verified，维护解除、派发恢复、恢复问题0。普通本地部署 backupCreated=false，无历史副本；未做 schema 迁移。

原 Task 身份、需求r3/计划r4和三项成功前缀保持。Bytebase Task905仍 NOT_STARTED，TaskRuns原响应{}；生产只读副本 recovery=true/readonly=on，name列查询为空。真实真人决定尚未发生；未宣称生产业务完成。当前浏览器验收不可用，Observer仅实际渲染及事件测试，不宣称页面实测。

私有回执、消息ID、原生事件和部署细节保存在 docs/tmp/simple-database-change-20261002/private-approval-final-verification.json 与 docs/tmp/private-approval-deployment-round17-20261002；不提交私有业务记录。第十三轮真实失败保留在 matrix.csv。
