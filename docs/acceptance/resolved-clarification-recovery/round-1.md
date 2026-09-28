# 第一轮：受控恢复回归

修复前正向用例实跑得到 `MESSAGE_REPROCESS_EFFECT_PENDING`，原因是原通知已独立确认送达仍被一律拒绝。未知发送结果的旧保护路径正常，不属于同一个准入条件。

修复后的实际验证：

- `node --test test/message-ledger.test.js test/message-workflow.test.js`：117/117 通过，0 fail、0 skipped。
- `node --test --test-name-pattern='本机操作者逐条重处理|Web与IM引用同一澄清' test/workflow-service.test.js`：2/2 通过。
- 已送达通知与已接纳答复保留；新请求身份独立，答复跨重启保留，重复恢复命令幂等，原通知不能再领取。
- 仅 ACK、发送中、未知结果、未答复、R 单元澄清和已有业务命令仍拒绝，原来源保持不变。
- 实际工作流的 S 收到原问题与答复，运行结案，新增通知 0、业务命令 0。

本轮尚未部署；真实群旧记录恢复与已有验收输入的回复将在安装修复后独立回读，不能由测试结果替代。
