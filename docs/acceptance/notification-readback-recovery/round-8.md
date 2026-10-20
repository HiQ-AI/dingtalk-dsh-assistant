# 第 8 轮：按原成功发送回执确认送达

2026-10-20，原通知发送任务 SUCCESS，精确消息可读；旧逻辑因列表及段落换行渲染差异返回 sameDeliveredText=false。发送次数基线为 1。

## 修复与反证

只对原 openTaskId 查询 SUCCESS 且精确消息 ID/会话一致的路径直接确认送达，不增加正文归一化规则，也不声称正文、引用或 @ 已核验。回执缺失、消息缺失、错误 ID/会话、SENDING/FAILED 不结清；无成功任务回执继续严格匹配正文、发送者、引用和 @。unknown 调用 send 会使测试直接失败。

- `node --test test/task-notification-readback.test.js test/task-notification-delivery.test.js`：38 tests，38 pass，0 fail，0 skipped。
- `test/workflow-notification-obligations.test.js`：65 项通知回归通过；与前两文件上一轮联合输出 102 pass（新增边界用例前），0 fail。
- `scripts/inspect-original-notification.mjs`：对当前原通知只读查询原发送任务和原消息，proof.identity=send-receipt，原 messageId 与原发送时间不变，calls 仅两个读取命令，writes=0。
- 部署 Check：writes=0、signals=0、46 个持久会话排空、unknownOperations=0、unknownNotifications=1。

部署在 install 阶段失败：原 profile 平铺旧 CLI 缺少 @deepseek-ai/cordis-plugin-group，未完成安装。旧 PID69116 已原生退出、46 会话离线排空、自动启动禁用；保留 failure.json 和原通知 unknown，未重发。后续按 round-9 接续原安装阶段。完整本地证据位于 docs/tmp/notification-receipt-deploy，不提交渠道正文与完整现场日志。
