# 复审修复与首次汇总

本轮承接 `retrospective.md`。历史最小复现原始输出保存在 `round-4/review-baseline.log`：混合调查与无关写入曾被接纳，通用业务检查调用次数为 0；消费者也未拒绝未知合同版本。该文件来自实施前的实际复审输出，不是修改后重新执行旧源码。

## 实施与局部验证

- 按逐项引用分派领域验收责任，所有领域通过后由 Host 生成并持久化业务接纳回执；Owner 不能用无关文件或外部操作成功补齐业务缺口。
- 调查沿用逐项意见，工程沿用冻结需求及实际业务用例，通用/外部/投递采用受限的本领域检查；旧执行定义摘要保持，当前完成准入另记实际规则摘要。
- 消费者声明支持的类型和版本，目录由权威结果合同派生；规范补齐受理、拒收、合法结局及 Owner/领域/节点/Host/渠道职责。
- `contracts.log`：调查、通用与阶段合同 44/44；`acceptance-binding.log`：新增工程条目绑定及 Host 证据防冒充等 6/6。
- `sg7-service-final.log`：服务入口 8/8，包括无关写入拒绝、有效保存接纳、错项拒绝、原生零工具检查协议及 v4/v5 持久恢复。SQLite/Controller/Owner/效果账/文件均实际运行；模型流和外部系统为夹具。
- `sg7-domain-check-green.log`：原生检查协议 16/16。早期 `sg7-domain-check.log` 中两项失败来自默认通用版本升级后仍断言默认 v4 的旧测试；已改为显式历史版本摘要检查，保留该日志。
- `sg7-service-red-baseline.log` 明示它是实施前真实工具输出摘录；早期服务正例日志为 `sg7-service-green.log`。

## 首次汇总结果：未通过

命令：`pwsh -NoProfile -File docs/acceptance/workflow-domain-contracts/scripts/verify.ps1 -Suite all`。

24 个相关测试文件，554 项，552 PASS、2 FAIL、0 SKIP，305563.7607 ms，退出码 1。完整输出为 `round-4/final.log`，不能将本轮登记为全绿。

1. 恢复扫描模拟 Controller 缺少 `workflowDefinition` 查询接口；真实 Controller 已有该接口。补齐只读模拟，不在产品代码增加绕过。
2. 工程前缀保留与 UAT 重建场景仍使用合并验收项并将全部阶段引用分给该项，且无业务检查器。新领域准入拒绝完成，需要用真实分工调整夹具并继续验证；不能放宽完成门禁迁就旧断言。

后续修复与重跑记录在第五轮，不覆盖本轮失败证据。未运行全仓测试、真实模型、真实钉钉或正式部署。
