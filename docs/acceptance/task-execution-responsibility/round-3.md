# 第三轮：组合回归

日期：2026-10-13。

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `node --test test/execution-controller.test.js test/task-owner-session-native.test.js test/execution-session-native.test.js` | 286/286 PASS，0 fail/skip | round-2/contract-tests.log（第二轮启动，第三轮完成） |
| `node --test test/workflow-recovery.test.js test/task-owner-recovery.test.js` | 36/36 PASS，0 fail/skip | round-3/recovery-tests.log |
| `node --test --test-name-pattern='暂态恢复无次数\|交付只读恢复\|PR网络恢复\|服务自动恢复PR\|旧provider未提交\|执行恢复被\|关闭等待既有恢复\|Owner可观察可恢复\|Web暂停恢复' test/workflow-service.test.js` | 23/23 PASS，0 fail/skip | round-3/service-regression.log |

包括原生角色提示、禁止 Owner 修复、未知效果、原会话/节点身份、成功前缀、归档、无进展、并发观察与关闭等反例。未运行全库测试；未部署或调用真实模型业务任务。后续诊断分类一致性收口见第四轮。
