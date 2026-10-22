# 第4轮：团队边界、定向通信与每轮文档

本轮接纳用户追加的三项约束：Task 执行团队 3–10 人；成员可以直接协调；统筹优先查执行文档且每轮文档保留。R1–R3 单执行策略的样本只作历史，不能证明新增要求。

## 实现与判据

- Store 在同 key 幂等回读之后限制第 11 个新成员；Owner 完成门禁拒绝已有 1/2 人团队，纯咨询零执行可完成，依赖未齐可先 wait。续办/模型恢复/反馈不增加人数，已有历史超额记录保留可读。
- 直接消息沿原反馈账持久化，绑定发送者租约、接收者输入版本与同 Task；稳定 key 幂等。内部消息不产生外部效果账，接收和模型步骤消费不代表业务落实。终态成员拒绝投递且不重启。
- 执行文档由现有账本生成 `tasks/<taskId>/outputs/<executionId>/round-<inputVersion>.md`。同轮持续更新，跨轮前发布旧轮，后续使用独立路径；更高轮出现后拒绝旧轮倒写。`plan` 同轮省略保留、新轮不沿用，旧阶段报告不伪装当前进度。文档路径逐层拒绝链接，当前文件原子替换并独立读回。
- 统筹和团队入口提供当前文档，日常通过原生文件读取；异常和证据缺口再查原账。文档+执行字段来自同一个串行快照，阶段 wake 仍保留精确原报告引用。发布失败显式告警，不能吞掉已提交 claim/result 回执；严格文档读取和跨轮切换仍须成功。

## 确定性验证

所有 native 测试使用仓库锁定 `test/fixtures/native-profile/package.json`，脚本化模型只选择工具，实际 Host/Store/会话/文件路径真实执行。以下不是线上业务或真实模型自主行为证明。

| 合同 | 结果与证据 |
| --- | --- |
| 成员边界、反馈账、资源与版本 | `peer-store-final.log` 101 PASS；追加 plan 定向 `execution-plan-store-after.log` 4 PASS |
| 最终账/文档/时间轴/UI 投影 | `final-ledger-documents-ui.log` 145 PASS |
| 文档路径、冻结、链接拒绝、隔离导入 | `execution-doc-files-after.log` 17 PASS |
| 模型上下文与历史报告可追溯 | `model-context-doc-wakes.log` 18 PASS，当前 MD 更新后原 wake 仍可读取原报告 |
| 已提交 claim 后真实文件错误 | `execution-doc-claim-failure-native.log` 1 PASS；无执行模型/无外部操作，原 execution failed 且 drained，明确文档路径告警 |
| 同 Task 通信 | 文档接入后 `document-peer-native-after.log` 2 PASS（并发容量 1/3）；幂等重发一条、实际消费、终态不重启；资源读取/续办另 2 PASS 在 `document-team-stage-native.log` |
| 技能边界 | 文档接入后 `document-team-stage-native.log` 技能 5 PASS |
| 执行模型恢复 | `document-provider-recovery.log` 8 PASS、1 timeout；仅超时项孤立复验 `document-provider-supplement-isolated.log` 1 PASS，原断言未放松 |
| Owner 原生服务 | 初次整份 `../round-8-service-native.log` 39/41；工具引用读取修复后相关 7/7 在 `../round-9-service-team.log`，其余 34 项保持原通过证据 |
| 作业恢复 | `../round-8-job-native.log` 11 PASS |
| 人工与历史分页 | `human-native-after.log` 8 PASS；`http-history-pagination.log` 1 PASS。分页保留 53 条合成历史，当前创建仍受 10 人上限约束 |

表内未列出的最终文档进度与打包复验结论，追加在后续轮次记录中。所有路径默认相对 `round-4/`。不将失败日志中的局部 PASS 合称整份通过。

## 首错与修正

- 旧单执行夹具无法通过新增人数门禁：明确增加两个具有真实读取职责的验证成员；不是在 Host 全局偷偷自动补人。
- 团队输出超过 Host 3KB 预算后，旧测试直接找 inline 数组而未读 contextPath。改用现有引用解析器发真实 `model_content_read`，保留各业务断言；服务、作业、通信与包验证分别补跑。包测试旧夹具重复读团队造成超时，精确停止该测试子进程，失败日志完整保留。
- 文档模块新增 import 后，两个隔离复制夹具遗漏 `execution-context.js`。仅补必需依赖；触发混合测试审定 hash 门禁后，重新审阅注册与历史路径再更新摘要，不调整分类来跳过验证。
- 旧巡检/阶段夹具依赖 inline objective/stageProgress 或原日志 limitation。改成真实读取本轮文档，仍保留 Store/时间轴原报告断言，未删除结果验证。
- R5 模型首次揭示首次定时检查前 `progressReview` 未定义时，主动读取进度会输出非 lossless JSON。生产与隔离评估一起改为省略缺失可选字段，另补无该字段的原生调用反例。其首次错误保留在 R5，复验另记 R6。

## 真实模型 R4 历史样本

该批发生在每轮文档接入前，使用真实模型和生产 Store 合同，禁止业务执行。8 类中共享写入样本结构通过但语义失败：将同一文件的关联修改拆成两个串行写者，徒增交接。已收紧为同一写者统一完成相关修改，R5 重新验证。team-complete 的结构失败是评估器错误要求非空 evidence；生产允许空数组，实际完整读证并正确回答两个版本均为 2.4.1，独立语义通过。其余六类语义通过。

旧原始 trace、第一次错误和 source 快照保留 `docs/tmp/task-collaboration-model-round-4/`；可提交摘要见 `round-4/model-results.json`。这些样本不能证明新增执行文档行为，也不能证明普遍加速。
