# 第 2 轮：话题批量意图与多流程 Task 实施

日期：2026-09-24。用例定义见 `../../spec/topic-intent-task-composition.md` 第 8 节；唯一状态总表为同目录 `matrix.csv`。

## 本轮结论

- 已实施 R 后持久话题归属、同群待归类屏障、每话题独立批量 IB、同话题新输入重判及来源逐条授权。IB 结果在其他话题 R 未完成时可持久保存，归类完成后按原话题版本复用，不重复调用模型。
- 业务 Task 有阶段计划、确认门禁、固定阶段 Run 身份、成功产物交接、重启扫描与旧成功 Run 显式续办。执行中新意图若只追加后续阶段，当前 Run 保持不变；实质修改仍走原 Run 输入屏障。
- 通用 `task-general` 只调用 Host 登记的能力并逐步核验。UAT 等受信适配器缺失时，阶段保留为 `blocked`，没有发送或提测成功声明。

## PASS 证据

| 用例 | 实跑断言 |
| --- | --- |
| M01 | `test/message-workflow.test.js` 的三消息用例：最后一条 R 挂起时 IB 调用为 0；释放后 IB 调用 1 次，创建处理器只调用 1 次。 |
| M02 | 两话题 IB 判断用例在共同释放门禁前同时进入各自 topicId，证明不是同一判断会话串行执行。 |
| M03 | 同话题新输入在第一次 IB 运行中抵达；两次批量规模为 1、2，旧候选零派发，S/R 各仅执行两次。 |
| M04 | 另一话题 R 挂起期间，原话题 IB 完成但未派发；R 完成后两话题各派发，原话题 IB 调用仍只有一次。 |
| M11 | 两发送者同话题用例逐单元调用 Host 授权；无权发送者未继承首条来源的权限。 |
| T05 | `test/workflow-service.test.js` 中纯排查完成后续办：Task ID 不变、旧 Run 保持成功、计划版次递增，第二 Run 独立启动，任务卡仍为一张。 |

定向回归命令 `node --test --test-reporter=dot test/message-workflow.test.js test/execution-task-plan.test.js test/workflow-service.test.js test/workflow-recovery.test.js test/observer-client.test.js test/task-general-workflow.test.js` 返回 exit 0，107 项均通过。最终一次全仓 `pnpm test` 返回 933/933 PASS；其后新增三消息 M01 用例定向 PASS，且受影响的消息、计划和服务三个测试文件联合回归 exit 0。`execution-task-plan.test.js` 覆盖 v1 控制库 `--check` 零写、备份升级和版本读回；未触碰现场控制库。

## 未闭环

矩阵其余用例保持 `NOT_RUN`，不把单元/合成测试外推为真实开发→UAT、渠道送达或生产效果通过。当前没有配置受信 UAT 提测适配器，无法证明真实 SHA、部署版本、提测记录和送达闭环。真实持续流量的误关联率、延迟及 token 对照亦未测量；因此不生成 `report.md`。
