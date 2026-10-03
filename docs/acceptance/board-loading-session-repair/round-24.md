# 持续任务执行与验收作用域

用户要求综合单执行会话的连续性与流程编排的可控性，给方案、实施并验证。设计见 `docs/spec/continuous-task-execution.md`。状态以 matrix.csv 为准。

## 实现与反证

持久 Owner 负责目标、问题诊断和路径调整。通用可纠正 Agent 节点可经 Owner 读取诊断后，回到相同 nodeRunId/sessionId/generation/inputDigest 续行；成功前缀不重跑。Controller 与 SQLite 同事务守住来源、版本、排空和效果状态；历史恢复记录识别相同问题，不能仅增租约就无限重试。重复无效候选忽略摘要及等待说明的措辞，退避后保留负责人。内部修复说明与公开群正文校验分开，修复通知始终静默。

真实运行反证：858 删除阶段已成功，旧857加列实时回查却要求列仍存在，Owner 以 POSTGRES_COLUMN_VERIFICATION_UNCONFIRMED 受阻。根因是历史阶段证据浏览无条件触发 live readCompletion。现保留全部历史批准/执行/当时回查的严格绑定，只将当前验收项显式引用的阶段用于实时回查。同领域历史阶段不再自动承担当前验收项。

初次原生回归失败：新增指导误用了第二个 complete system-prompt section，宿主拒绝多个完整提示词；已合并到唯一原生 section 后原组95/95通过。原始工具错误结构新增导致旧断言不匹配也已同步。未将这次失败伪称环境问题。

## 已跑验证

- `node --test test/execution-session-native.test.js test/task-owner-session-native.test.js test/task-owner-store.test.js`：95/95通过，原生JSONL跨进程恢复保留历史、原输入和恢复说明；真实权限失败保留原始码并停止排队工具。
- `node --test test/task-owner-session-native.test.js test/workflow-notification-obligations.test.js`：后续68/68通过，说明改写不能绕过空转检测、内部修复不受公开正文限制且不发群。
- `node --test test/workflow-approval.test.js test/execution-effects.test.js`：43/43通过，审批竞争、身份与效果边界。
- Owner合同/恢复/交付清单相关40/40；通用恢复诊断补强3/3；另真实Owner→合同→Controller→SQLite→执行适配器续行1/1通过。原生会话持久化由前述原生用例独立覆盖。
- 历史/当前状态验收定向：领域4/4、合同13/13、Service与冻结版本恢复11/11通过；历史错误proof和当前证据归属不正确均拒绝。

最终 `node --test test/task-release-workflows.test.js test/task-workflow-contracts.test.js test/execution-controller.test.js test/execution-store.test.js`：126/126通过。覆盖Controller/Store的同问题防重放、跨重启恢复上下文、诊断时需求/计划/控制版本CAS、审批/未知效果/真实权限拒绝；历史回查原文不被收窄为特定JSON列协议。

发布前发现既有冻结摘要回归：先前删除maxSteps/timeoutMs摘要字段后，测试仍硬断言旧摘要。独立运行旧HEAD同样失败；仅在内存还原两字段能精确复现旧摘要。现利用既有legacyDigests保留历史身份，当前摘要和执行行为继续不含旧上限；测试验证旧身份仍可恢复，而非改成另一个无证据的常量。

## 部署反证与修正

首次r24包启动失败，EXTERNAL_WORKFLOW_DEFINITION_DRIFT，未恢复派发。v4完成策略的rulesDigest包含reader函数源码，本轮改变reader导致已落盘定义无法恢复；旧定义回归未覆盖这个真实合同。现从部署前r23正式包恢复v4原函数，新增Scoped v5承载新的历史/当前验收语义；当前登记、历史定义恢复、Host动态验收分别按版本处理。新增冻结原函数与定义摘要回归，release整文件15/15、service相关13/13、合同13/13通过。实际失败记录保留，不能将首次包视为部署成功。

本次普通部署未备份历史副本，原离线修复脚本仅支持有备份历史回滚路径，缺少精确替换包并保留当前数据的接续入口；按既有maintenance封存/控制历史/包及profile摘要/独占锁补齐此入口，不用备份绕过用户要求。正式部署与实际Task最终验收仍待回读。本轮未代审批、未手工执行生产SQL。

独立只读审查：真实stage4/6的原readback输入摘要及workflowDigest匹配；Scoped v5可完整核验历史批准/执行/原回查且不调用生产适配器。stage6承担当前最终验收项时必达readCompletion入口（sentinel验证，审查本身网络0次）。03:31另独立连接生产只读副本确认表存在且name列不存在。私有证据索引：docs/tmp/continuous-v5-independent-review.md、continuous-live-proof.json、continuous-production-readback.json。
