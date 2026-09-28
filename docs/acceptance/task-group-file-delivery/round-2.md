# 持久工作流与定向回归

`verify-file-workflow.mjs --mock` 实跑独立 SQLite、受管文件、Delivery 和 Controller；三节点及三个效果成功，发送计数为三。真实渠道模式同样得到三个成功效果；Markdown 155 字节、SQL 117 字节、PNG 68 字节，各自下载摘要与原文件一致。没有修改正式实例或业务库。

PNG 素材后来经 IDAT 解压发现损坏，因此本轮只证明原字节传输，图片有效性记 FAIL，转第三轮修复素材并补验；不覆盖本轮记录。

核心定向命令：`node --test test/task-artifact-files.test.js test/task-artifact-write.test.js test/task-group-file-delivery.test.js test/execution-message-delivery.test.js test/task-general-workflow.test.js test/dws-file-adapter.test.js`，45/45 通过。另补跨节点同交付键测试后，发送效果文件 18/18 通过。

关联命令：`node --test test/workflow-service.test.js test/task-owner-recovery.test.js test/task-workflow-contracts.test.js test/execution-task-plan.test.js test/dws-adapter.test.js`，192/192 通过。

提示词命令：`node --test test/message-workflow.test.js test/task-owner-session-native.test.js test/message-answer-cancel.test.js`，73/73 通过。修复了 DSH 唯一 complete section 约束，Owner 文件规则并入原 section。

反例覆盖路径与 junction 逃逸、字节篡改、容量、任务版本、错群、未授权、无 ACK、恢复对账、不盲重放。原始渠道记录仅保留在忽略目录 `round-2/`。
