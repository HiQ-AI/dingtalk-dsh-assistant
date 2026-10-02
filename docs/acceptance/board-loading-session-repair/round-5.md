# 第五轮：简单数据库变更送审流程

此前把字段用途、类型和全量依赖调查作为送审前置的结论已被用户纠正。本轮保留历史失败/通过证据，按 `docs/spec/simple-database-change-flow.md` 执行。

代码与验证：调查 v9、Owner 和群协调定向 65 项通过；原生 Bytebase/数据变更/可信平台定向 27 项通过，包含两轮驳回后同 Task 修订再送审；Host 定向 36 项通过；任务服务完整 213 项通过。最终客户端 19 项、需求修订及等待投影定向 2 项通过。v3/v8 冻结恢复未改写。记录位于本轮私有 `docs/tmp/simple-database-change-20261002/`，不提交业务及凭据。

生产只读 smoke：确认只读事务和副本身份；准确表存在、name 列不存在；单条可空无默认值 character varying 加列候选与固定列目录回查通过预检。未执行生产 DDL。

正式部署：零写 Check 回读 100 文件，包 SHA256 `186e02221ada8f1615fa0b1628796e847c8a2977f3fc0704fad3fb61cc770dd4`。完整备份、安装和新 PID 46780 已独立回读；旧四个 Run 和一张原 Task 保留。health=ok、inboundProcessing=true。维护解除和真实送审仍需后续回读。

群消息：两条错误调查/业务规格等待说明已撤回。独立在默认近七天的原群精确搜索两个特有正文，均 complete=true、count=0、failedCount=0；消息详情保留历史正文，不将其误判为未撤回。未发送重复开始通知。

部署维护解除已独立回读 ready=true、recoveryIssueCount=0。原 Task 修订入口发现 RUN_TERMINAL：消息来源入口错误地以末个调查 Run 成功等同 Task 业务完成。原生审批的新等待原因还缺自动恢复路由，两项正在修复，不能以完整服务旧测试全绿替代真实接续验收。

修复反证后：业务终态与Owner等待context定向6项、Service原生审批自动对账及既有恢复/控制屏障13项、原生审批两轮修订3项通过。第二精确包SHA256 9f8cdc347312af1de66f16612329662cfa8b11f295906affab0cc1ffd1d3b0c5，100文件独立校验，PID19660，Resume ready=true。稍后health=ok、inboundProcessing=true。

新增真实红复现：明确需求修订目标后，Owner active验收仍为旧要求。普通补充语义应保留验收，明确替换须原子更新活动验收；原Task仍revision1，尚未接纳新指令，不迁移历史或直接改线上SQLite。
