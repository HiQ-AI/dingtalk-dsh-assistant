# 第一轮验收记录

日期：2026-09-21。验证环境：独立 worktree `worktree-task-waiting-progress`，未切换本机正在执行任务的 DSH Web 实例。

| 用例 | 结果与证据 |
| --- | --- |
| R01 | PASS。Runtime 测试验证第二阶段可先于第一阶段登记，跨序结果仍经主会话审阅。 |
| R02 | PASS。Runtime 测试验证重复阶段与不匹配的剩余阶段集合被拒绝。 |
| R03 | PASS。`task-input-revision` 测试验证定向重规划只使受影响阶段失效。 |
| R04 | PASS。Runtime 测试验证等待通知包含“已暂停”、引用反馈消息，并同时触达反馈人与任务发起人。 |
| R05 | PASS。Runtime 测试验证送达前不提醒，送达后 30 分钟及 2 小时各一次，重复巡检不重发；通知投递失败生成告警，确认送达后解除。 |
| R06 | PASS。Runtime 测试验证同版本恢复时旧通知失效；历史已送达询问仅按指定任务补一次更正，送达前不催促。 |
| R07 | PASS。`pnpm test`：457 项通过，0 失败。 |
| R08 | PASS。`node scripts/build-web-client.mjs`、两个 JS 语法检查及 `git diff --check` 通过；Assistant/Observer 打包后文件分别为 154951/19932 字节，SHA256 分别为 `317FFB841BBEAB96AF8B6E8BC650C7E96A0B54F05371EACB001FF685ED81E3F8` / `BE02A9C8DC10B78B242A91E96D0F33828B783EB7600C193C961354F1CBA34FBB`，包内关键实现已回读。 |
| R09 | PENDING。本机仍有两个运行中任务；安装、当前任务定点更正、真实 DWS 送达回读均未执行。 |

本轮仅证明隔离代码及安装包行为。R09 完成前，不宣称当前线上等待任务的进度或群通知已纠正。
