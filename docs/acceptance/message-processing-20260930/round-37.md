# 第37轮：持续执行与恢复

日期：2026-10-01。实施批准的 `docs/spec/task-continuous-execution-recovery.md`，当前轮新增验收项 A29—A34；原生产业务 A14 不转为通过。

## 最终行为

- 删除节点步数、任务累计时长、Owner失败次数、领取次数、补充静默窗口、队列数量及验收计划总量截止；schema7 删除 `execution_runs.max_claims` 和计数上界。并发及读取分页仅用于资源调度，不终止任务。
- 同一条件的确定性实现失败不原样循环；可纠正候选交回同Owner，暂态故障持久退避，无尝试次数截止。恢复后沿用Task、节点和成功前缀。
- 材料读取失败不按次数制造人工阻塞通知。真正无法自动推进的Owner阻塞首次即准确告知，同一阻塞只一次；不逐条回应补充。
- 完整业务输出独立于有界诊断日志；候选、受管仓库、远端读取和PR分页不因旧大小限制丢失内容。验收仍校验完整标准、预期和真实结果，不以启动成功代替业务成功。
- Git、PR、验收子进程串联显式取消；取消等待实际进程退出。网络连接、单次探测和停止工具的协议等待仍保留，不是任务总执行窗口。
- PR只有在Host独立验证完整未发送日志后，才以新lease恢复同effect。未知、已发送、无证明、权限错误均禁止盲重发。效果恢复事务仍核对身份、当前输入、占用、安全围栏和审批。
- 配置生成器与运行时同步，移除旧timeout字段；旧字段直接拒绝，不做兼容。

## 实跑证据

以下为实际测试组结果，不合计为去重用例总数。初始组合回归后，对后续改动逐项增量验证。

| 范围 | 实跑结果 | 核心断言 |
| --- | --- | --- |
| 节点会话、Controller、Agent工作 | 82/82 PASS | 超过旧步数、纠正次数继续；取消、身份、输出合同仍有效 |
| 工作流服务、通用任务、Owner账/会话 | 270/270 PASS | 真实等待与失败区分、同Task接续、可纠正决定不永久耗尽 |
| 群协调、消息账、PR、本地验收 | 150/150 PASS | 条件未变不频繁重试、材料总量与内部重试无截止 |
| 控制账、计划、HTTP合同 | 85/85 PASS | schema6→7保留全部业务行摘要；移除预算接口 |
| 工程配置与任务发现 | 33/33 PASS；后续工程27/27 PASS | 无索引和验收数量截止；远端读取失败只一次探测 |
| 候选、数据变更、外部效果 | 21/21 PASS | 大材料接纳，审批和未知效果安全边界保留 |
| 交付、运行时、工作流、合同与Controller | 83/83 PASS | 取消信号到实际工具，提交/推送回执丢失先对账 |
| 受管工作区 | 13/13 PASS | 真实17MiB文件clone、冻结及完整摘要；漂移仍拒绝 |
| 原生PR与交付运行时最终回归 | 14/14 PASS | 同effect两次网络失败独立落账，Controller/Store重启恢复，PR创建一次 |
| 效果恢复事务 | 22/22 PASS | 未发送证明、输入/租约/围栏/审批/占用反证均拒绝错误重放 |
| PR自动恢复调度 | 4/4 PASS；持久退避2/2 PASS | 无新输入也按retryAt唤醒；立即重扫和控制账重开不能跳过退避；成功前缀只执行一次；无证明/已发送不恢复 |
| 最终工程工作流 | 13/13 PASS | clone→修改→冻结→检查；80条标准、每条40步和大计划完整接纳，漏标准/不存在场景仍拒绝 |
| 最终通知责任 | 32/32 PASS | 首次真实阻塞告知、重扫不重复、暂态读取静默、恢复后旧告知失效 |
| 配置生成器 | 16/16 PASS | 新前后端检查被真实构造器接纳；旧timeout字段拒绝 |
| 合并验收/启动/工程修复脚本 | 30/30 PASS；加强取消2/2 PASS | 同Run新代修复、完整2MiB stdout、显式取消后PID确已退出 |
| 独立80节点Run | 1/1 PASS | 同Run80个节点全部完成，全部输出完整，claim_count=80 |
| 原生重规划/重发冻结定义 | 2/2 PASS | 删除原生重规划的32节点上限 |

可复验命令：`node --test test/execution-session-native.test.js test/execution-controller.test.js test/agent-work.test.js`；`node --test test/execution-effects.test.js test/execution-delivery-runtime.test.js test/execution-pr.test.js`；`node --test test/task-workflow.test.js test/workflow-notification-obligations.test.js`；`node --test test/execution-workspace.test.js test/execution-workspace-runtime.test.js`；`node --test test/local-acceptance-merge.test.js test/bootstrap-workflow-maintenance.test.js test/execution-engineering-repair.test.js`。使用Node24、PowerShell7和D盘TEMP，原始本机日志在本轮私有 `docs/tmp/continuous-execution/`，不提交运行凭据或真实群消息。

## 本地部署

按原生维护排空、封存许可、精确包安装、新实例独立回读的路径执行，遵照用户要求不创建备份。最终安装包SHA-256为 `5be9d3cda0a56ebed4469a6b0b5d1102f1eb7a3c91cc192f01fa31ded936586a`。

新实例PID24384，父启动进程23804；assistant100、observer4、原生模型适配器17个文件，合计121个文件与精确包和对应源码一致。认证Web200、token交换303、控制health=ok、inboundProcessing=true、recoveryIssueCount=0。维护revision282已解除，独立回读schema7、无max_claims列、完整性ok、外键错误0。原消息1482条、来源112及消息运行142条与部署前一致；Task/Run/Owner均为0，实际profile无已废弃执行预算字段。

## 边界与反证

- 以上原生任务、临时仓库和CLI受控替身覆盖真实控制账/进程路径，不等于真实GitHub外部写入或生产库改数已验收。
- 原业务已被明确结束；用户授权清理后当前业务Task/Run/Owner均为0，不重建旧业务验升级。原始消息保留。
- 外部服务持续故障、实际权限缺失及人工审批仍可能等待；保证条件满足后持续推进，而非声称外部系统永不失败。
- 原A14生产全流程保持FAIL，不能用本轮测试或健康状态替代其业务验收，也不生成原目标全绿report。
