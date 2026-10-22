# 第18轮：DSH 原生团队按需拆分

用户撤回至少3/最多10个执行会话要求，并停止Claude原生Teams接入。本轮基于 origin/main 12f13e0 的独立工作树，删除统筹/成员提示和Host完成/创建人数门禁；保留默认DSH、按需交接、每轮文档、并发容量、资源互斥、未知效果和排空保护。原Claude候选留在旧工作树。

## 分工与证据

- collaboration_eval：生产最小修改与Store测试，见 `round-18/implementation-execution.md`，源码摘要及123项通过见 `implementation-results.json`。
- coordination_lessons：既有原生Host用例的0/1/2/11人、原身份续办、逐轮文档和完成保护，见 `round-18/validation-execution.md`；首轮两处测试假设失败完整保留，修正后新结果归R19。
- progress_audit：独立差异及现场只读核验，见 `round-18/review-execution.md`；当前有效后端dsh、健康ok、恢复告警0，见 `runtime-readback.json`，不代表新代码已部署。
- 统筹：README/运维说明/跨轮模型验证脚本同步，原生资源及模型配置8项通过（`native-resources-model.log`），脚本`--check`通过且模型调用0（`model-harness-check.log`）。

## 首错保留

原生定向首轮7项中5通过、2失败：新增负例错误期待工具输出保留Store错误码，并把shell exit1误当作unknown。实际合同为阻塞对象JSON与已完成工具回执；修夹具验证准确身份和回执丢失，不改生产语义。初次运行未冻结所有源码，不能作为旧版反证。

release-smoke首轮12通过、2个包用例超过30秒，原日志`round-18/release-smoke-1.log`保留。沿已支持的RELEASE_PACKAGE_DIRECTORY入口使用本轮真实固定包，复验只重跑两失败项，不修改原时限；结果在R19。源码、模型行为、安装和业务验收分别记录，本轮未调用真实模型或业务渠道。
