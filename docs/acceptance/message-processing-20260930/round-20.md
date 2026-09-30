# 第 20 轮：首次领取执行时钟与真实重放

## 修复

首次成功领取模型节点才建立执行时钟；维护与领取前排队不消耗执行窗口。旧账从真实节点领取时间推导执行年龄，不重置已消耗预算；无真实模型领取的旧超时经正常恢复继续处理。已独立回读的纯状态通知，在没有业务命令时允许受控重处理，原回执保留；未知、发送中、仅ACK及业务效果仍拒绝。

## 本地验证

- 三组相关测试148/148通过，最终语义收紧后定向5/5通过。
- 精确Assistant包99文件与源码一致；Observer沿用已验证4文件包。摘要见round-20-packages.json。
- 维护revision160，nodes/owners/effects/messages均0；零写部署预检通过。
- 扩大集成、正式部署和真实重放结果待独立回读补入，不以打包或预检代替完成。

## 本机原始证据

敏感原始消息、回执及模型输出仅保存在docs/tmp/message-processing-deploy/；公开记录仅包含必要状态与测试结论。

- 扩大集成：node --test --test-concurrency=2 test/message-ledger.test.js test/message-impact.test.js test/workflow-service.test.js test/http.test.js test/workflow-notification-obligations.test.js；287/287 PASS，0 fail、0 skipped，156975ms。
