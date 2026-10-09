# Round 84：固定工程重启复用真实检查回执

## 结论与边界

原生完整工程链通过：实际 Git 候选、一次检查、本地 HTTP 业务验收，精确维护停止派发后关闭/重建 registry/controller，原 Run 继续 commit/push/PR。检查计数文件独立回读仅一行 `check`；原 verify outputRef、verification digest 不变，最终严格交付证明通过。不代表现场 SG20 已完成。

Host 仅从本 Run 当前成功且排空的 verify 节点恢复票据，核对原定义/Task、节点版本、需求摘要、generation、仓库及完整 checks 配置；节点输入 JSON 不能成为票据。真实候选或检查配置改变仍须验证。旧 v18/v19 回调文本和已接受图保持可恢复。新模型动态修改图入口已撤，既有历史审计保留。

## 实跑

- `node --test test/execution-candidate.test.js`：18/18 PASS，112.7 秒。包含新增 Host 票据恢复、检查版本/工件摘要/候选篡改拒绝。日志 `docs/tmp/fixed-candidate-receipt-tests-rerun.log`。
- `node --test --test-name-pattern '工程交付证明复用' test/workflow-engineering.test.js`：1/1 PASS；不再接受 prepare-commit 另一份重验摘要。日志 `docs/tmp/fixed-delivery-proof-tests.log`。
- `node --test --test-name-pattern '固定工程重启后' test/workflow-engineering.test.js`：1/1 PASS，68.4 秒。日志 `docs/tmp/fixed-check-receipt-native-boundary-final.log`。隔离产物 `docs/tmp/dsh-revision-6lT0HR`，`check-count` 独立回读只有一次。
- `node docs/tmp/check-fixed-original-registry.mjs`：当前控制账只读恢复 5/5，版本 18/18/18/18/19，原登记摘要全匹配；没有派发或业务写入。日志 `docs/tmp/fixed-flow-original-digest-check-final.log`。

## 首轮失败如实保留

新增 candidate 测试初次括号语法错误，修正后全文件通过。工程夹具先缺原生工具 AbortSignal；随后试图越过真实本地验收直接 commit，被 LOCAL_ACCEPTANCE_RECEIPT_INVALID 正确拒绝；加强为完整业务链。维护钩子初版取错 nodeRunId 而未停止，改为正式命令 nodeId。最后边界首次未接住维护后的下一次 node.claim 拒绝 RUNTIME_MAINTENANCE_ACTIVE；只修测试捕获此精确拒绝并核原生状态，生产维护门禁不变。日志分别保留 fixed-check-receipt-integration、integration-rerun、native-signal、real-restart、native-boundary。

## 当前 SG20 真实诊断

原 plan-local-acceptance 原生会话 f141342e-49c5-46b5-a8c5-b831cf82cb8a 提交 `{cases:[]}`，prepare-local-acceptance 因 LOCAL_ACCEPTANCE_PLAN_INVALID 等待。实际原始输入有 criterion-1 和正确 dataset-merge-ui 场景。交由原执行会话补正完整计划，不由 Owner 改图、不重新开始整 Run。只读证据 `docs/tmp/sg20-fixed-flow-diagnostic.json`；实际恢复部署由主线程执行。
