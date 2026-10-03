# 普通调查直查的最终验证

Task Owner 持续负责读取、查询、分析、同轮纠错和推进。当前目录不注册 task-investigation，查询结果经原生账与工件绑定本次 Task、需求、轮次和租约；跨轮只传引用并按需回读全文。纯只读任务无阶段、无 Run，仍须通过真实证据和一次最终语义验收。工程 v18 直接接收当前 Task 查询上下文；既有工程保持冻结。SQL、文件、工程交付及插件真人审批保留效果核验。

恢复扫描不等待模型会话；接纳消息持久化后扫描待办，每任务单会话，最多四个派发工作。实际占用结束补位；未来重试及未接纳的输入不触发忙循环。服务用例已证明慢 Owner 持续运行期间，另一 Task 的既有文件阶段仍可观察并最终验收。动作应用并发请求触发再次扫描，避免漏掉刚接纳的动作。

## 回归证据

- 相关核心 12 文件 312/312 PASS，0 skipped：查询工具、原生会话、Owner 证据/最终合同、SQL/插件审批和外部效果，私有日志 `docs/tmp/direct-core-stable-round35.log`。
- 独立工程工作区 13/13 PASS：真实 Git 工作目录、代次、并发与失回执边界；私有日志 `docs/tmp/direct-workspace-short-docs-final.log`。
- 最终工程与领域门禁定向 6/6 PASS，真实查询至工程方案、当前版本与伪证据拒绝、UAT及原节点证明：`docs/tmp/direct-service-engineering-owner-async-final.log`。
- 显式等待原生 Owner 状态的服务定向 8/8 PASS，两个慢会话非阻塞用例保留原服务入口；`docs/tmp/direct-service-explicit-settle-final.log`。
- 恢复全文件 19/19 PASS，包含真实 SQLite 未来重试及输入屏障防空转、解除后原会话继续；最后关联合同回归 47/47 PASS。
- HTTP、工作流入口及工程工作区运行接口三个文件 37/37 PASS；`docs/tmp/direct-entry-http-final.log`。
- 工程相关三文件原轮次 41/42 PASS，歧义用例的包装器漏传 includeRecovery；修正后两个 Owner 工程恢复用例 2/2 PASS，原 Run 新代、旧证据和并发边界均独立回读。
- 完整服务快照 300 项：278 PASS、22 FAIL，耗时 630427 毫秒。失败均定位到旧测试同步入口/恢复返回值/单轮读取次数的假设。混合查询写入的 9 项、只读交付及等待投影的 5 项、Bytebase 审批与工单边界的 11 项分别复跑通过；当前仍收尾原发送人和取消删除用例。保留此失败轮次，最终整份覆盖另记下一轮，不把分组回执冒充本轮全绿。

完整回归发现两个真实交接问题并修正：恢复状态与诊断须同一原生快照，Owner 读取阶段证明也请求 includeRecovery；旧模型测试未读取真实修复诊断，已按现有门禁先 readArtifact，不放宽合同。Windows Git 工作区使用原生 cwd；测试临时文件放较短的仓库 docs/tmp，超过 Windows CreateProcess 工作目录长度的环境边界仍存在，本轮不缩短身份摘要或改目录协议。

## 部署及边界

预打包 Check 为零写、普通部署无历史备份、Task 数量为零。最终源码及回归稳定后须重新打包，再沿现有维护/安装/Readback/Resume完成部署；此刻未部署。

本轮隔离测试使用 HTTP、SQLite、真实工件/Git/文件及原生事务；模型和通知使用隔离适配器。未发送真实群消息，未创建生产工单、执行 SQL 或代替真人批准；不恢复已授权清理的旧 Task。
