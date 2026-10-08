# Round 25：群回复清晰与完整缺项

## 根因与最小修复

Owner 等待通知把分析摘要压平并截前 160 字符，尾部具体问题可能丢失。直接使用现有 business-input condition.missing 表达缺项，保留完整换行、选项和链接；权限确认与完成结果保留完整摘要。共享群回复指引要求先结论/行动、逐项列清问题，Owner missing 使用业务措辞而非内部字段名。既有记录不由格式器猜测拆句，后续生成从源头采用清单。

其他消息澄清及授权路径已直接通过 formatGroupReply 保留完整 question；新增定向证明。通知 payload 保留 sourceMessageId/actorId，由原渠道引用回复提供事项上下文。未改变通知静默、权限、发送或回读规则。

## 实跑

- `node --test test/workflow-notification-obligations.test.js test/task-owner-session-native.test.js`：83/83 PASS，23.35 秒。日志 `docs/tmp/clarification-tests/sg11-group-replies.log`。
- 新增其他请求路径后 `node --test --test-name-pattern '完整保留多行问题' test/workflow-notification-obligations.test.js`：2/2 PASS。日志 `docs/tmp/clarification-tests/sg11-other-replies.log`。
- 覆盖超过 160 字符的完整多行缺项、尾部链接、权限正文、最终结果；内部故障仍静默；澄清/授权保留来源引用和完整问题。

仅本地受控测试，未部署、未发送线上消息，尚未证明真实模型会稳定产出简明清单。

## 同轮钉钉清单回读补证

真实更正采用四项编号清单，DWS发送状态SUCCESS且精确消息ID回读存在。DWS的消息文本投影会删除连续编号项间单换行，因此旧sameDeliveredText将已送达错误留为acknowledged。修复仅对期望正文中的连续1、2、3编号项作已实证变换，保留正文、顺序、编号和链接，不对普通换行、空行或代码块套用。

`node --test test/workflow-notification-obligations.test.js test/group-reply-audience.test.js`：62/62 PASS，29.03秒。新正例及正文/编号/顺序/链接/空格差异负例通过。独立读取真实发送快照与mget结果，sameDeliveredText=true、sameGroup=true、sameSource=true。原始群数据仅保留docs/tmp，不入库；正式操作待部署后只reconcile，不重新发送。
