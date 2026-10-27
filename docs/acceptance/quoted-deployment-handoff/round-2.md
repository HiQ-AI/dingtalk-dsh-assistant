# 第二轮：受控恢复、交付与现场边界

## 恢复合同

仅显式 `coordination-context` 精确恢复同消息版本/activeUnitRefs/原预约代/ledger fence/安排revision；旧预约未保存引用、原来源保有引用、作者和当前版本相符、原安排无成员/日程/occurrence/job/接受效果才接纳。原 source/coordination/Task 身份不变；fence推进，旧语义戳和问题入审计，不清失败预算。

旧prepared且无发送许可、尝试、ACK和回执的澄清原子退休；delivered逐字保留；starting/unknown/ACK边界拒绝恢复。接纳后新通知独立产生。再次同问题clarify用新fence幂等键，保留安排history，不重发旧问题。

## 已验证

- 六文件原生协调、账本、预约、DTO、HTTP、Observer回归：152/152 PASS，无跳过；新增发送边界及历史保留定向6/6 PASS。
- 最终身份/正文类型门禁补强后，账本+预约+DTO再次运行：64/64 PASS，无跳过。日志 `docs/tmp/quoted-deployment-handoff/final-recovery-rerun.log`。
- 原生重判测试：误澄清后通过真实service精确恢复，复用原coordinationId/原Task、runSequence=2；原delivered通知字节不变且仅送一次，旧token拒绝、recover不重复重开。属于原生合同验证，模型受控、渠道替身。
- `node scripts/test-suites.mjs update/check`：309个测试文件逐一登记，历史仍3，无Release删减。引用资源读取增加传递依赖后3个原unit文件正确归compat，自动平衡64项lane；不是删除测试。

最终冻结后 `DSH_NATIVE_TEST_PROFILE=<原生profile>/package.json pnpm test:release-smoke`：14/14 PASS、0 skip。实际tgz解包逐文件字节/全部静态引用核对、独立依赖装配、真实原生resident启动/health及任务验证通过。早次打包测试因源码补强与打包同时进行造成字节核验拒绝；最终冻结源码后重新跑，不放宽字节核验断言。日志 `docs/tmp/quoted-deployment-handoff/release-smoke-final.log`。

真实模型隔离验证及PR/包身份将在本轮追加实际结果。

## 现场部署阻断

已按runbook执行只读静止核验，返回 `DEPLOY_NOT_DRAINED`。之后独立只读账本确认3个执行仍running、1个operation仍starting。未停止服务、未安装候选包、未重判#313；原错误澄清仍保留。完整数据库约9GB，quick_check耗时不能代替排空条件。后续须等真实执行自然排空后重新按原生双包脚本Check，再切换、回读包/PID/健康和原消息，不能强停或直接改账。
