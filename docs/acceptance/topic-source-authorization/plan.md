# 群话题授权恢复验收

原话题 topic-6810ca2c8cddff3f3a1585bb4f909b6b，原任务 task-7c7b8c0d7287a6bd0de4e2a2519ba764。现场拒绝发生于 task.reopen 前，16:23:36 决策 blocked，16:40 后 revision=5 / processedRevision=2。李辰是原任务作者，向春梅是后续部署消息作者。

验证按真实原生 fixture 的路由、持久来源、任务账、会话与通知执行，模型仅脚本化决策。旧错误注入在 task.reopen 写入前，解除后从原消息 retry，检查原任务/会话、同一决策、runSequence 仅增加一次。另跑 Web、人工答复和 Topic 定向回归。每轮结果进 matrix.csv，运行边界及部署证据另记 round-N.md。

本地部署必须保留现场另一轮已安装的 Provider 冷却复核与列表回读修复（依赖 PR #207），不覆盖其改动。读取当前安装包及进程，沿 task-session-clean-start 原生排空双包流程执行 Check，再实际安装并独立回读。恢复仅调用原消息重试，不直接发送群消息、不新增业务任务。
