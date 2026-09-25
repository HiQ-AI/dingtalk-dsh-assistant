# 第四轮：任务事实与通知恢复

本轮状态以 `matrix.csv` 的 `round_4` 列为准。执行中的断言和读回在这里追加；历史 R01/R02 的 FAIL 保留，不用本轮合成测试抹掉已经发生的真实错误。

| 用例 | 验收对象 | 证据状态 |
| --- | --- | --- |
| F01 | 话题意图读到原 Task、Run、结果与限制，跨群事实不可见 | PASS：`workflow-service.test.js` 的“只关联话题时意图仍读到已执行Task及结果限制”；隔离重演 #51/#52 同话题，外部调用 0 |
| F02 | Run 成功与目标评估分开，材料分析有限结果不被判作未执行 | PASS：同一测试核对 Run `succeeded`、目标 `unassessed`、结果和 limitations 均保留；原现场 Run 回读仍为 `succeeded` |
| F03 | 同人相邻两个话题不因时间邻近而强制关联或授予权限 | PASS：`message-workflow.test.js` 的“同人相邻消息仅排序候选，R 可保留跨话题歧义”；特定句式加 90 秒的 `mayCreate` 旁路已删除 |
| N01 | task.accepted、task.result 是不同事件，各能正常投递 | PASS：`message-ledger.test.js` 的“承接与结果是不同事件”，`workflow-service.test.js` 的真实接纳与结果通知测试 |
| N02 | 同事件重试、ACK 未回读与重启均不重复发送 | PASS：`message-ledger.test.js` 的 ACK、重启未知与事件键去重测试；旧发送实例不重复领取 |
| N03 | 撤回预检逐条核对，混合清单保留正确任务通知 | PASS：受管 API 只接受单条通知；`workflow-service.test.js` 验证无负责人精确原消息不能预检，已完成的合法通知不会因同源自动入撤回清单；`http.test.js` 拒绝数组与额外字段 |
| N04 | 补发幂等且与原通知关联，未知外部效果只核对 | PASS：`workflow-service.test.js` 验证撤回重复执行不再调用外部、补发独立成行；`message-ledger.test.js` 验证操作身份和未知状态 |
| L01 | 六条现场消息 `--check`/对账后只改账本，原 Task/Run、外部消息数不变 | PASS：隔离副本先 `--check`/`--execute`；停机备份后现场再执行。原四通知 `recalled=4`、补发记录 `replaced=2`，`message_runs=66`、`execution_runs=5` 未变，原 Run 仍 `succeeded`；部署后 DWS 完整会话查询 `complete=true, hasMore=false, failed=0`，目标仅两条补发可见 |

本轮全量 `pnpm test`：949/949 通过、0 失败。对账脚本 `--check` 的 externalCalls=0、ledgerWrites=0；`--execute` 仅记录 7 次账本命令及 1 个证据工件，不执行 DWS 操作。现场对账前后 `message_items` 从 407 到 409（新增两条补发关系，通知更新为原行），消息运行数 66、任务 Run 数 5 均不变。启动后 PID 24648 同时监听 3080/18998，`/health status=ok`、`recoveryIssueCount=0`；Assistant 安装目录内 `message-ledger.js`、`workflow-service.js`、`resident.js` 与源码 SHA256 一致。钉钉只读会话完整回查可见两条补发，四条原通知仍不可见。原始 DWS 结果、测试输出及现场备份留本机，不入 Git。

历史轮次 R01/R02 的 FAIL 保留。本轮采用隔离重演，不把真实 #51/#52 重新送入业务流程；账号系统的实际查证仍缺业务数据与查询能力，不能据本轮测试声称问题已查清。
