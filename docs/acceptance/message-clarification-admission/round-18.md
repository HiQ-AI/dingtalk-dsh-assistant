# 阶段授权来源候选纠正验证

## 根因与修改

现场 sourceQuote 为“按文档开发”，stageAuthorizations.objective 却是扩写描述，触发 Host 逐字来源校验。该拒绝正确，但原生提交缺少该错误的同轮字段纠正反馈。保留校验，仅明确业务目标与授权证据字段的区别，错误返回 received:false 由模型自行修正；不改写来源，不新增用户澄清。

## 本地验证

- node --test test/message-coordinator.test.js test/group-coordinator-session-native.test.js：62/62 PASS，11688.4486 ms。
- node --test --test-name-pattern='工程授权原文回归' test/workflow-service.test.js：3/3 PASS，3704.8465 ms。
- 覆盖错误候选零Task/命令/请求、同轮正确候选唯一Task、跨消息和跨作者来源拒绝；原生测试验证收到反馈后重新提交且来源身份保持。
- git diff --check PASS。
- Assistant SHA256 fffbf26879be07cf79f2ad200390c473010de4b80a8df8e376efb91afae9fda2，独立包源码核验 verifiedFiles=100。部署 Check 返回 online=true。

部署和现场任务结果单独回读后追加。

## 部署与现场边界

源码提交 76ddaeb；部署 PID 129740，包 SHA256 与上文一致，安装 verifiedFiles=100；正式部署回读 ready，已退出维护。独立 HTTP 回读 health=ok、inboundProcessing=true、recoveryIssueCount=0，maintenance.active=false。

现场状态进一步确认：旧协调轮在本次部署前已改为不提交可选阶段授权并接纳 #125，原版本 2 的创建命令已存在，不能再次 reprocess。该命令为 unknown / MESSAGE_INPUT_PENDING，task-1edb9931ffe6ecd4efc0a3949376d66f 尚不存在。

只读控制库定位到另一个阻塞：#124 点名消息的旧 pending unit / clarification request 尚在，同话题 task input guard 因此拒绝创建。其问题“你希望我评审规则、排查现有实现，还是按文档开发？”与后续原#125有关，但没有被原生请求链消费。第三条 clarify-3e2227… 通知仍已送达，本轮没有扩展撤回范围或伪造答复。授权字段修复及同轮纠正本地验证通过；真实任务承接仍未完成，不能将部署成功当作Task成功。
