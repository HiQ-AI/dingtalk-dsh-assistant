# Topic 回复对象与收件人纠正验收报告

日期：2026-10-29（Asia/Shanghai）

## 结论

本次限定的本地受控 Host 修复与风险相关回归通过，独立只读审查在已审源码和测试范围内暂无剩余已证阻断。`matrix.csv` 共保留 53 条历史记录；按 round 数字取每个 case 的最新状态，22 个范围内 case 为 PASS，4 个为 OUT_OF_SCOPE，case×round 无重复。这不是 22 个独立测试的汇总，也不是全仓测试通过声明。

提交、推送及新 PR 的最终真实状态由本桶 `goal.md` 记录；本报告不代表已合并、部署或真实钉钉现场验收。

## 问题、根因与修复

- A 提出要求、B 最后补充解释时，旧 Host 使用最后一个 basis 真人作者决定回复及 @，会覆盖应选 A 的语义对象。修复前脱敏基线实跑 1 FAIL，实际 explanation-b、预期 request-a（4554.1953 ms，exit 1）。当时决定没有新路由字段，该基线不证明 Host 应猜测未提供的对象。
- Topic 现通过 `replyToMessageId` 和 `atOpenDingTalkIds` 显式输出路由，Host 在持久接纳前复用固定 Topic 来源与参与者校验，不按姓名、纠正关键词或 basis 顺序另选人。省略或空 @ 数组默认提醒已选目标作者；非空数组必须唯一且属于固定参与者。
- 原 schema 已允许 `actions: []` 加 reply；修复不将问题误归为 schema 禁止空动作回复，而是明确助手沟通对象纠正与业务转派的区别。可沟通而保持任务，也保留无需回复的 reason 分支，不强制每次纠正另发消息。
- 公共 outbox 和独立通知 scanner 对群、Topic/revision、任务绑定及冻结正文/引用/@ 对账。scanner 使用原 operations 派生 taskIds，避免决定已阻断但 prepared 通知仍错误外发。合法恢复复用冻结 payload，旧无路由且无可信冻结证据时拒发并待对账，不重放已成功动作。
- formatter 不再用单目标默认 @ 覆盖显式多收件人；附件不可用的重建回复也保留路由字段。

## 实跑证据

以下分组含重叠覆盖，不相加为独立测试总数。原始命令、数值、历史失败及边界分别保留在对应 round 中。

| 验证 | 实际结果 | 能证明的范围 |
|---|---|---|
| round-2 新定向 | runtime 11 PASS、媒体 1 PASS、native 多 @ 1 PASS，均 exit 0 | 显式 A 不被最后 B 覆盖；非法路由无动作/外发；默认 @；纠正不改任务；媒体失败回复不丢路由；service 实际发送桩 payload 保留多 @ |
| round-3 runtime + decision | `node --test test/topic-runtime.test.js test/decision.test.js`：177 PASS，0 FAIL/SKIP，6596.2022 ms，exit 0 | 相关两文件原断言及新增路由回归；不代表全仓 |
| round-4 归属/来源 | 6 PASS，664.8663 ms，exit 0 | 固定 Topic 真人、陌生/重复 @、共享消息主 Topic 归属拒绝合同，拒绝前无业务应用/外发 |
| round-9 projected 子用例 | 整组失败中的 projected 子用例通过 | notification-only 真实投影无 decisionId 时仍按可信冻结身份复用；不把整组改记为 PASS |
| round-10 两冲突 | 2 PASS，3594.5996 ms，exit 0 | revision 与 taskIds 冲突均在持久终态拒绝，精确身份错误且 send=0 |
| round-11 prepared | 1 PASS，4259.4232 ms，exit 0 | 生命周期诊断及有界终态等待后，合法 prepared 单次恢复的冻结正文/引用/@ 与幂等断言通过 |
| round-12/16 引用身份 | 1 PASS，878.6744 ms，exit 0 | 引用他人或外群已送达通知不授予本群归属，陌生 at 被拒、外群账本不变；同名展示不替代稳定 ID |
| round-12 完成/阻塞代表 | 2 PASS，9524.1469 ms，exit 0 | 完成/状态署名保留引用和真实 @；blocked 决定转为明确持久请求并续接原任务 |
| round-13 三处手写调用 | 6 PASS，39308.2232 ms，exit 0 | context missing/preserve/replan/cancel、Web 原图原 Topic 复用、Host pre-effect 恢复；只补当前合法路由，原断言不变 |
| round-14 材料历史真实 group ingest/helper | 1 PASS，5968.4886 ms，exit 0 | 源文本和附件字节归属自己的任务且复用不重复下载；临时 cwd 在 finally 清理 |
| round-15 通知恢复代表 | 6 PASS（4 主 case 含 starting/unknown 子 case），13724.6618 ms，exit 0 | starting/unknown 只回读；ACK 重启不重发；native unknown 不重放已完成业务 |
| round-16 来源语义戳修后 | 1 PASS，2653.141 ms，exit 0 | reason 夹具移除残留路由字段后，保留原落账时序、无任务/通知及幂等断言 |

原生验证均指定 `DSH_NATIVE_TEST_PROFILE=D:/dsh_home/profiles/web/package.json` 复用依赖入口，使用临时 root/数据库、结构化脚本模型及通知桩，没有启动正式 profile 或真实外发。

## 独立审查与调用方影响

review 最终核对了已审实现、共享 helper 及三处非 helper 迁移，未发现剩余已证阻断。共享 helper 只选固定输入中的真人来源；23 个引用不等于 23 文件都已实测，不用文件名判断历史排除。必要材料历史真实调用已定向执行。故意非法决定及 legacy 无路由负例未机械补字段。

单真人夹具中的末条选择只对各自固定输入成立，不证明多参与者语义理解；多参与者执行合同由显式 A/B 专项证明。源码静态审查确认没有硬编码业务姓名/纠正关键词发送规则，也保留不回复分支；不将该结论扩大为真实模型自然语言稳定性。

README 的公开回复合同和 `docs/ops/task-session-clean-start.md` 的冻结复用、缺证据先对账、starting/unknown 只回读及禁止直接补发规则已同步。

## 保留的失败与残余风险

- round-2 的 174/177 与 round-6 的 36/37 原失败保留；夹具迁移和归属返回合同修复后按原断言复验，不删除失败断言。
- round-5 的 6 个超时取消仍保留为无结论，不计通过。
- round-8 同 revision 错 taskIds 反例曾出现 decision blocked 但 send=1；修复 scanner 绑定后 round-10 实测 send=0，原反例保留为 FAIL。
- round-9 两冲突过早读取 accepted，未执行到 send=0；后续通过有界等待持久终态修正测试观测，不改生产异步模型。round-9 整组仍保留 2 PASS / 2 FAIL / 1 CANCEL。
- prepared 曾有一次 30 秒取消且无调用栈；后续单次通过不能证明旧超时根因已修，根因仍未证。
- 历史 notification 未保存的任务版本字段不能声称完整核验；fixed-topic 空 refs 是本次未扩修的基线疑点。

## 交付回查

- 修复提交：`aaa7d823b908f1ca2528cb39632b29f7a6cb9ea9`；推送后独立 `git ls-remote` 回读一致。
- 新 PR：[#297](https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/297)，`fix(topic): 保留语义回复对象并修正收件人纠正沟通`。
- 2026-10-29T18:08:11+08:00 独立 `gh pr view` 回读：OPEN，`main ← worktree-topic-reply-recipient-correction`，正文、标题及修复 SHA 符合预期，`mergedAt=null`。
- 本报告及目标状态回填仅为后续文档提交，不改变已验证源码。没有合并、部署、手动 CI 或真实消息副作用；原六窗口保留。

## 未验及禁区

未执行真实 LLM 同名/任意自然语言纠正消歧、真实钉钉送达、正式数据库或突然进程 crash；未覆盖全部 replyReview 替换与通知冲突组合。优雅关闭重开不等于突然崩溃验收。

没有扩大跨群收件人或任务授权，没有扩建完整跨 Topic 主回复架构，没有 schema 迁移、正式库操作、真实消息重放、补发/撤回、部署、合并或手动 CI。回退须先暂停新接纳并对账未完成决定和冻结通知，不能删除账本或重放成功动作/发送。
