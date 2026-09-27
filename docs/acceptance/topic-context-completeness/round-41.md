# round-41：框架职责与结果交接实施

日期：2026-09-27。实施起点 `89dfe72`，依据[已批准方案](../../spec/workflow-session-responsibility.md)。本轮覆盖源码实现、隔离验收及 PR 交付；运行实例与真实 UAT 提测另行部署验收。

## 实施范围

- Controller 在纯结果规范化、schema、后继映射边界接纳明确失败，保存诊断及已生成的有效产物；存储写入或提交回执未知保持原事实并回查。受信执行器的失败 JSON 材料统一登记，不按工程错误码决定是否保存。
- Owner 读取当前阶段的失败材料，通过持久事件重新发现等待/失败节点；成功验收引用与诊断用途分开，领域扩展引用受当前 Run 已登记工件范围限制。
- Workflow 的 ownerContract 进入定义摘要，完成、领域产物读取和修复规则由受信领域模块提供。只读调查允许带范围说明结束；必要来源及工程业务验收仍需真实证据。
- 待启动冻结 Stage 与已有 Run 均按原 digest 选择定义。新合同版本及旧无合同任务的升级限制同步到手册和运维说明。
- 原生会话在工具体执行前按注册 schema 反馈可修正参数错误；合法提交不能覆盖，原步数/时限保持，权限、取消、身份失效和未知执行错误仍停止。
- 修复资格由冻结的领域合同判断。准备结果经进程内不可伪造票据绑定，Controller 再读当前事实，Store 在同一事务内检查版本、排空和未定效果；不再以工程名称或错误码决定公共准入。事件使用 `workflow.repair.accepted`，旧工程修复事件仍可读。

新建 `task-workflow-contracts.js` 的原因：现有文件分别负责业务 Host 或领域执行，没有负责按冻结定义分发读取/完成/修复合同的位置。该文件只复用 Controller、Store 和工件，未引入新任务队列、状态库或调度层。

## 验证记录

第一轮核心 70 项，63 通过、7 失败：5 个子用例发现诊断缺少 nodeRunId，已补实际绑定；一个父用例随子项失败；另一个故障注入误修改冻结 Store 对象，改为通过代理包装真实 Store。第二轮 Controller 29 项，28 通过、1 失败：提交已落盘但回执丢失时，控制器已经回查到新状态并正确继续，修正测试预期为不重做前节点并完成。两轮日志保留在本地 docs/tmp。

第三轮核心执行、原生节点会话、TaskPlan、Owner 原生会话及 Owner Store 共 90/90 通过，0 失败、0 跳过。

第四轮扩展到控制库、效果账、Delivery、外部操作、只读/通用能力/发布定义及 UAT 失败接续，共 191/191 通过，0 失败、0 跳过，用时 28.56 秒。组合审阅发现 Store 修复接纳仍依赖工程 ID/错误码，已按上述公共准入收口，并增加第三类流程实际修复用例。

领域首次 46/51：四项旧夹具/断言未同步新合同、诊断材料或确定失败状态，一项发现 Store 重发前缀遗漏 v16，已修正产品实现。Service 首轮 102/114，缺合同的人工流程及虚构来源引用被新门禁拒绝；改为真实领域合同和输入材料 ID 后第二轮 113/114，剩余同类来源夹具修正后单项通过。没有删除反例或放宽产品门禁。原始失败日志保留于本地 docs/tmp，[失败日志摘要与哈希](round-41/initial-test-summary.json)归档。

## 最终隔离验收

| 范围 | 结果与证据 |
| --- | --- |
| 核心执行、会话、Owner、Store、效果账、发布路径 | **194/194**，0 失败、0 跳过；[日志](round-41/core-tests.log)，28.76 秒 |
| 工程修复、工程 registry、工作流、业务 Host、合同 | **163/163**，0 失败、0 跳过；[日志](round-41/domain-tests.log)，284.98 秒 |
| 最新合同补验，含正式 Host 两次启动恢复 | **9/9**，其中 8 项与上一组重复，新增 1 项；[日志](round-41/contracts-tests.log)，3.65 秒 |
| 历史定义身份 | analysis v1、五类只读 v1、capability v2、工程 registry v15 共 **8/8** 与 `89df536` 一致；[结果](round-41/legacy-digest-check.json) |
| 手册原文示例与链接 | 三个隔离执行用例通过、43 个本地引用有效；[结果](round-41/guide-validation.json) |
| 本地安装包 | **83 个 JS 文件**与源码逐字节一致，含新增合同模块；[结果](round-41/package-check.json)，未安装 |

| 矩阵用例 | 本轮结论 |
| --- | --- |
| C48（R1） | PASS：Date/Map/undefined、后继 mapper 和 schema 错误持久收口；I/O 故障不伪造失败，提交已落盘但回执丢失不重做 |
| C49（R2） | PASS：已回答但有信息局限的调查可完成；缺来源或未满足验收仍拒绝 |
| C50（R3） | PASS：重开控制库后按冻结摘要启动旧 Stage；缺历史定义明确阻塞 |
| C51 | PASS：手册示例、引用及当前合同说明 |
| C52 | PASS：上述定向组合；真实远程交付不计入本项 |
| C54 | PASS：提交后、Owner 唤醒前重启仍发现失败材料，重复观察不重复执行或产生事件 |
| C55 | PASS：第三种库存流程只靠合同接入产物、验收和真实修复；伪造准备票据/输入/上下文及未知效果均拒绝；修复不重置累计预算 |
| C56 | PASS：同一原生租约内修正工具参数与提交格式；预算耗尽退出，身份、权限、取消与已接纳提交不可绕过 |

执行位置为本 worktree；TEMP/TMP 仅在测试命令进程指向 D 盘的 `docs/tmp/framework-tests/main`，没有修改全局环境或活动实例。复跑命令：

```powershell
New-Item -ItemType Directory -Path docs/tmp/framework-tests/main -Force | Out-Null
$env:TEMP = (Resolve-Path docs/tmp/framework-tests/main).Path
$env:TMP = $env:TEMP
node --test --test-concurrency=2 test/execution-controller.test.js test/execution-session-native.test.js test/execution-task-plan.test.js test/task-owner-session-native.test.js test/task-owner-store.test.js test/execution-store.test.js test/execution-effects.test.js test/execution-delivery.test.js test/execution-external-delivery.test.js test/execution-delivery-runtime.test.js test/task-readonly-workflows.test.js test/task-release-workflows.test.js test/task-general-workflow.test.js test/workflow-uat-failure-continuation.test.js
node --test --test-concurrency=2 test/task-workflow-contracts.test.js test/execution-engineering-repair.test.js test/workflow-engineering.test.js test/task-workflow.test.js test/workflow-service.test.js
node --test test/task-workflow-contracts.test.js
node docs/acceptance/topic-context-completeness/round-41/legacy-digest-probe.mjs
node docs/acceptance/topic-context-completeness/scripts/verify-workflow-authoring-guide.mjs --output docs/acceptance/topic-context-completeness/round-41/guide-validation.json
$packageOutput = Join-Path (Get-Location) 'docs/tmp/framework-package'
pnpm --filter @zzusp/dingtalk-dsh-assistant pack --pack-destination $packageOutput
python docs/acceptance/topic-context-completeness/round-41/verify-package.py
```

`pack` 的目的目录使用本仓库的绝对路径，避免 pnpm 按子包 cwd 解释相对路径。历史摘要 probe 仅对比定义工厂，导入助手仍来自当前树；摘要一致不等于全部旧业务行为已重新验收。新增 Host 用例独立覆盖旧/新配置重启选取，活动实例仍未升级。

独立复审已检查 Controller、Owner 和原生 Session：确定性契约失败与 I/O 未知分开，诊断引用与成功验收分开；权限、失效身份及未定外部效果没有获得重试旁路。当前没有发现必须阻断交付的问题。

## 未验证边界

尚未在活动实例安装此版本，未重跑真实开发/UAT 业务链，未发送通知。旧无合同活动任务不能自动取得新合同；正式部署前应在原版本完成或通过正式入口结束后重执行，不改写旧数据。本轮没有 schema 迁移。
