# round-39：编排框架审查与新流程建设手册

日期：2026-09-27。审查基线：`89df5360752c0fb5f9793c208156530d65f9baf3`，PR #125 合并后的 main。

本轮交付是审查及手册，不包含产品代码修复。**发现三个已复现的 P2 问题**，现有流程可作为扩展基础，但不能声明异常恢复和升级路径均已稳定。后文明确当前事实与建议修改，避免把建议当作现成能力。

## 审查范围及证据

- 主审查：消息目录、业务 Host 接入、Task Owner、阶段交接、工程 v15、本地验收、UAT/生产职责、产物及页面投影。
- 独立审查：固定定义、Controller/Store、效果账本、租约、结果接纳、恢复、历史定义和手册接口。
- 新 worktree 独立执行 `pnpm install --frozen-lockfile`；所有复现使用合成对象或 `docs/tmp/workflow-authoring-guide/` 等隔离目录。未读取活动业务库，未发送消息，未触发真实流水线。
- 旧业务任务的 UAT 成功记录保持历史意义；本轮不以它们替代新反例，也没有证据宣称它们正在遭遇下面的缺陷。

## R1 / P2：执行结束后的产出或后继映射异常没有持久收口

**触发条件**：code 节点返回 Date 等非普通对象；或当前节点产出之后，下一个节点的 `mapInput` 读取缺失属性而抛 TypeError。

**当前行为与影响**：实际执行已结束、`drained=true`，但 Run/Node 都仍为 `running`，`outputRef=null`、`waitReason=null`；Controller 保留内存错误。`recover()` 返回 `RUN_NOT_RECOVERING`，自动恢复扫描跳过 running，任务不能在当前进程自然收口。前一个节点已经产生的工件也没有进入其成功输出引用，界面难以解释卡在哪里。

**源码**：`packages/dingtalk-dsh-assistant/execution-controller.js:208` 先记录排空，`:228` 开始产出验证与后继输入准备，`:245` 的 catch 只把 `NODE_SCHEMA_INVALID/ARTIFACT_TOO_LARGE/INVALID_JSON_VALUE` 转成持久失败，遗漏非普通对象错误和 mapper 异常。`execution-artifacts.js:18` 抛 `INVALID_JSON_OBJECT`；`workflow-service.js:2008` 跳过 running。

**复现与反证**：[脚本](round-39/framework-contract-probe.mjs)、[输出](round-39/framework-contract-probe.json)。普通 JSON 对象的同类流程成功；Date 和 TypeError 两个反例均出现上述卡住状态。因此不是“所有 code 节点不能完成”，而是产出接纳阶段错误分类有缺口。

**具体修改方案**：

1. 把执行、产出规范化/schema 校验、后继 mapper 与后继输入校验、工件/控制账持久化分段处理。
2. 已知契约错误与 mapper 异常统一转为可定位的持久失败，记录当前节点、目标节点、阶段和受控错误码；保留已执行产物的诊断证据。
3. 存储不可用或提交结果未知继续停止派发并走对账；不能用泛 catch 把 `COMMIT_ACK_UNKNOWN` 等误记为确定业务失败。
4. 覆盖普通 JSON、Date/Map、非 JSON 值、后继 mapper 抛错、后继 schema 不符、工件写入失败和控制账回执未知。断言既不残留虚假 running，也不会推进下游或重做已发出效果。

## R2 / P2：只读调查的范围说明被当成任务未完成

**触发条件**：用户要求“查明现有材料能否确认某事实，无法确认则说明原因”。调查结果和验收引用已经齐备，但结果如实填写非空 `limitations`。已完成的前序阶段残留范围说明也会影响最终完成。

**当前行为与影响**：`authorizeCompletion` 对任何阶段的非空 limitations 直接返回 false，尚未按用户验收目标区分“交付已完成但结论有边界”与“缺少必须交付的证据”。这会拒绝本应可以结束的只读调查，诱导反复等待或省略范围说明。

**源码**：`packages/dingtalk-dsh-assistant/workflow-service.js:1062` 的 `outputs.some` 在逐项验收审查之前拒绝非空 limitations；`task-readonly-workflows.js:20` 等提示则要求如实说明未知、条件和未验证事项。只读结果引用结构通过不表示完成准入会通过。

**复现与反证**：[脚本](round-39/completion-boundary-probe.mjs)、[输出](round-39/completion-boundary-probe.json)。从当前源码提取实际 authorizeCompletion 回调，以相同成功阶段、验收项、引用和调查结论作为夹具：limitations 为空返回 true，仅加“当前材料不能确认创建人”就返回 false。此处是隔离回调决策验证，未重放真实账号调查或完整 Owner 会话。

**具体修改方案**：

1. 给完成合同增加明确的逐项业务判据：结论已交付、外部动作确已完成、必需验证通过分别验证。
2. 区分 informational limitations 与阻塞验收项；阻塞信息绑定 criterionId，不能用自由文本数组是否为空一刀切。保留 `blocked/unverified` 及必需动作未完成时的阻断。
3. 只读调查允许有范围说明的最终结果，但仍需同来源事实、明确结论和逐项验收引用；不能把“证据不足”无条件解释为所有任务均已完成。
4. 更新只读输出/Owner 完成合同及版本恢复，并覆盖“无法确认但调查结束”“要求实际修复尚未修复”“前序未知已在后序补齐”“伪造/过期证据”四类反例。

## R3 / P2：升级后待启动的旧阶段无法使用已保留的历史定义

**触发条件**：TaskPlan 的 ready Stage 已冻结 workflow v1 摘要，但尚无 Run；重启时同 ID 的当前定义升级为 v2，并正确注册 v1 为 historicalWorkflows。

**当前行为与影响**：`advanceTaskPlan` 抛 `WORKFLOW_VERSION_UNAVAILABLE`，Stage 保持 ready、runId 为空。保留历史定义足以供已有 Run 按摘要恢复，却不能保证这些已冻结且待启动的阶段继续，影响滚动升级中的业务计划。

**源码**：`packages/dingtalk-dsh-assistant/execution-controller.js:267` 的 createRun 只从当前 `definitions.get(workflowId)` 取定义，`:272` 只接受当前摘要/换行兼容摘要，未按 stage.workflowDigest 查 `byDigest`；同文件 `:79` 的已有 Run 恢复使用了 byDigest。

**复现与反证**：[脚本](round-39/pending-workflow-version-probe.mjs)、[输出](round-39/pending-workflow-version-probe.json)。使用真实一次性 SQLite 创建旧计划，关闭重开后提供 current v2 + historical v1，旧 ready 阶段被拒绝。此处不是未提供旧工厂；旧摘要明确已在历史定义表中。

**具体修改方案**：

1. createRun 带 stageBinding 时，从绑定阶段的冻结摘要查 byDigest，并核对 workflowId、planRevision、stageId、输入与当前阶段状态。
2. 不带 stageBinding 的新运行继续选当前 definitions，避免新任务无意选择旧版本。
3. 原摘要缺失、工作流身份不符、计划/要求版本改变仍拒绝；禁止把旧阶段摘要改成最新值规避校验。
4. 覆盖旧 ready 阶段、等待确认后启动、已有 Run 恢复、新运行选择 v2、旧定义缺失、错误 ID/过期绑定和换行摘要；确认没有旧函数偷偷替换的路径。

## 已核实的框架边界

这些是当前设计限制，本轮没有把它们全部定性为业务缺陷：

- 单 Run 是顺序执行，1–32 节点；前序依赖用于读取产物，不是并行 DAG。
- Controller 内存注册、持久注册、消息目录、Owner 可见性和阶段输入是多处显式接入；不存在仅加一份 JSON 自动上线新流程的机制。
- 定义摘要不会展开闭包和导入助手。独立 probe 已证明闭包值从 1 变 2、输出改变时摘要可不变；rulesDigest 必须覆盖这些规则。
- code timeoutMs 不提供自动中止；signal、超时、进程身份与真实排空由实现负责。
- allowedEffects 是受信代码约束而非 OS 沙箱；单 Node 的同一 action 只对应一个效果身份。
- schema 与工件摘要只证明结构和内容身份；业务成立、目录/文档存在、平台运行版本和送达都要额外回读。
- 工程 v15 的构建、本地验收、精确 PR/UAT 证据链有专门合同；新领域不能只复用一个通用 `passed: true` 字段。
- 生产 main/发布真实链和 DWS 重新授权仍为既有未闭环边界；本轮没有改变它们的状态。

## 文档交付

- [框架建设手册](../../../packages/dingtalk-dsh-assistant/README.md)：需求合同、架构、节点定义、完整接入表、可执行示例、产物、授权、恢复、开发/UAT参考、升级、验收和交付清单。
- 根 README 增加入口，并更正仍称“真实项目/远程 PR 未接入”的过时介绍；API 契约增加旧 Resident 合同与原生节点接口的范围说明。
- 独立审閱已指出并更正 capability 的 read.execute/file.write.prepare 区别、prepared 效果授权重查边界和旧待启动阶段的升级缺陷。

## 本轮验证状态

| 矩阵用例 | 内容 | 本轮结果 |
| --- | --- | --- |
| C48 | 产出/后继映射异常可持久收口（R1） | FAIL，两个错误输入复现；普通对象对照成功 |
| C49 | 只读调查按业务判据完成（R2） | FAIL，仅增加范围说明即被拒绝 |
| C50 | 旧冻结待启动阶段按原定义续行（R3） | FAIL，保留 historical 定义仍无法创建 Run |
| C51 | 手册示例与引用可用 | PASS，3 项隔离检查，文件引用校验通过 |
| C52 | 当前 Controller/Plan/只读/发布/业务 Host 定向回归 | PASS，175/175，0 失败、0 跳过 |

实际执行：

```powershell
node docs/acceptance/topic-context-completeness/round-39/framework-contract-probe.mjs
node docs/acceptance/topic-context-completeness/round-39/completion-boundary-probe.mjs
node docs/acceptance/topic-context-completeness/round-39/pending-workflow-version-probe.mjs
node docs/acceptance/topic-context-completeness/scripts/verify-workflow-authoring-guide.mjs
node --test --test-concurrency=2 test/execution-controller.test.js test/execution-task-plan.test.js test/task-readonly-workflows.test.js test/task-release-workflows.test.js test/workflow-service.test.js
```

三份问题 probe 的命令退出 0 表示“按预期复现缺陷”，不表示缺陷已修复。测试首次运行使用系统 C 盘临时目录，因 C 盘空闲 0 字节出现 `ENOSPC`，175 项中 46 通过、129 失败；[首轮摘要与原始日志哈希](round-39/initial-environment-failure.json)记录 SQLite 与 Git 临时仓库失败。原始 `round-39/targeted-tests.log` 在本地原样保留，不把重复环境堆栈入库。随后仅在测试命令进程内把 `TEMP/TMP` 指向本 worktree 的 `docs/tmp/workflow-authoring-tests/`，同一组测试全部通过，用时 108.45 秒，见[重跑日志](round-39/targeted-tests-d-drive.log)。没有清理用户磁盘或修改全局环境。

手册验证从文档原文提取示例，不复制一份独立“看似相同”的实现；实际运行三节点、回读最终工件、确认重放不重复建节点，并拒绝缺来源输入和伪造来源产物。结果见[手册校验输出](round-39/guide-validation.json)。已有测试通过没有覆盖掉 R1–R3 的新反例，三项产品行为在 matrix 中仍为 FAIL。

仅交付文档与隔离验证脚本，没有修改产品执行逻辑、部署实例、业务任务或外部平台。失败证据保留，历史业务全链结论不改写；不生成新的“全绿”报告。
