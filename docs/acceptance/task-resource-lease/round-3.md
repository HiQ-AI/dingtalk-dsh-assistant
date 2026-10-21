# 原生资源行为与技能验证

`node --test --test-name-pattern='native shared resources|native delegation rejects changed keys' test/task-session-service-native.test.js`：2 PASS、0 FAIL、0 SKIP，约 24 秒。原始输出 round-3-native.log。

- 真实原生会话证明：相同 uat2 资源的第二执行保持 queued/leaseEpoch=0，uat3 执行在持有者尚未释放时完成；等待不挤占两任务/两执行容量，不触发失败告警或模型忙循环。原持有者排空后，无需恢复定时器，等待者自动执行真实文件写入。
- 同派发 key 更换资源拒绝，重复原请求返回当前 succeeded/released；task_execution_read 直接带真实资源状态。原 executionId 续办省略资源仍保留 uat2，两个输入仅产生两次执行。

只读合并预检 helper：23/23；三个现有 skill 校验：3/3；本地链接：14/14。真实 GET 发现 PR.base.sha 是缓存值，修正为独立目标 ref 权威后重跑通过。独立六场景评审指出资源查询入口不够准确，修正为 task_execution_read 及本任务作用域，并定向重演闭合。详见 skill-contracts.md 与 skill-independent-review.md。纸面演练不替代模型端到端验证。
