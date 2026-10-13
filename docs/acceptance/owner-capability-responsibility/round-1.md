# 第 1 轮：原生工具及证据边界

## 实跑

- `node --test test/task-owner-session-native.test.js test/task-owner-store.test.js test/task-owner-recovery.test.js test/task-general-workflow.test.js test/task-owner-delivery-manifest.test.js test/task-owner-paused-delivery-review.test.js test/task-owner-context.test.js`：194/194 PASS。
- 补充 Host 证据测试及提示冲突修正后：`node --test --test-name-pattern='Owner原生工具自主执行|native Owner evidence|原生执行证据' test/task-owner-session-native.test.js test/task-owner-store.test.js test/task-owner-recovery.test.js test/task-general-workflow.test.js`：10/10 PASS。
- 独立源码审查未发现阻塞交付问题；`git diff --check` 通过。

## 证明范围

真实 SDK AgentLoop 用原生工具夹具执行失败、在同一会话修正并继续；禁止后台调用，无 Host 回执能力及暂停成果评估时不开放原生工具，过期租约和取消阻止后续调用。真实 SQLite 验证任务/需求/会话身份、控制状态和已登记完成引用，拒绝跨任务与未登记引用。

Host 保存工具真实参数和返回，折叠同一调用的开始/返回记录；失败不丢失，只有开始记录仍是未知。业务验收得到 hostNativeExecution 来源标识，执行返回本身不能直接变成业务成功。生产变更、发布及消息继续遵循受管入口的任务政策；本次没有新增任意 shell 命令语义隔离，不能声称网络只读或任意外部效果自动去重。

取消后 settled 文件可保存但索引会被 CAS 拒绝，后续 Owner 从 started 得到未知状态，需要独立回查；本轮验证了未知状态保留，没有声称原业务会话已完成真实对账。

## 未完成

尚未部署本次版本；原业务 Task 的自主执行、独立业务证据及群消息送达待现场验证。维护会话此前代做的业务结果不计入本轮。
