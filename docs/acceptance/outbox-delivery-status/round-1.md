# 发信箱状态和时间验收

范围：已送达主状态、替代关系附加信息、发送时间及回读时间、原生双包部署。沿用现有通知、HTTP 和投影测试；不发送新消息、不撤回历史消息，不对历史账做数据修复。

基线：原样本底账 sent/delivered，前端显示已替代并承诺等待替换通知送达后撤回。替换通知已 delivered，当前群替换撤回入口已退役。真实浏览器基线保存在本检出 docs/tmp/outbox-delivery-33c8030/browser-before.png，不提交含业务内容的图片或完整记录。

第一次定向测试：60 项，59 通过，1 项失败。失败来自旧断言要求 unknown+替代关系显示 superseded；更新为保留 checking，防止替代关系掩盖未知送达。

第二次：node --test test/observer-client.test.js test/task-notification-readback.test.js test/task-notification-delivery.test.js test/http.test.js，93/93 通过；node --test test/task-message-projections.test.js，11/11 通过。发送时间覆盖毫秒数字、13位字符串、北京时间及带时区字符串；缺失/无效时间不伪造，正文身份不符仍拒绝。持久回执和 Resident 投影跨重开保留 sentAt；历史不以创建时间/回读时间代替。状态筛选包含被替代的已送达通知，未知发送不重发。

node --check packages/dingtalk-dsh-observer/web-client.js、git diff --check 均通过；premium strict audit 无 findings。

部署与现场结果待追加到下一轮，最终状态以 matrix.csv 为准。
