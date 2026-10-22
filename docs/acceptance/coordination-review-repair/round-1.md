# 第 1 轮：分项修复

基线为 main `3d7a188`，隔离工作树分支 `worktree-coordination-review-fixes`。本轮为实现期快照，最终状态以 matrix.csv 的最新轮为准。

| 范围 | 证据 | 结果 |
| --- | --- | --- |
| R2/R3 账本生命周期 | round-1/ledger-tests.log | 36 PASS |
| 取消后 claim 历史身份与有效输入 | round-1/ledger-scope-tests.log | 14 PASS，与上项重叠，不累加 |
| R1/F1 计划及组合条件 | round-1/schedules-boundary.log | 33 PASS |
| F1 原生观察与计划 | round-1/schedules-native-final.log | 6 PASS |
| R4/Windows 强退恢复 | round-1/fairness-migration.log | 16 PASS |
| F2/F3 摘要与查询 | round-1/summary-query.log | 37 PASS |
| 测试分类清单 | round-1/release-workflow-mapping.log | 8 PASS |

实现期失败保留原日志：schedules-unit-2.log 暴露 snapshot 可选属性 undefined，已统一使用 null/空数组；summary-native.log 缺少规范毫秒时间；summary-native-2.log 夹具原任务未终结，正常恢复改变了任务。后两项按生产合同修正夹具，没有删除原任务不变的断言。

交叉审查补充：正常返回 waiting 的作业也不能占完成预算；局部取消后保留已绑定的历史身份但不继续生效；异常摘要发送许可在同一事务回读最新摘要，避免取消事实尚未被后台聚合时误发。
