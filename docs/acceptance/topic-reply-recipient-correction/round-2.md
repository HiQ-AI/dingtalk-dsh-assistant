# Round 2 — 定向行为验证与关联回归

日期：2026-10-29（Asia/Shanghai）

## 结果

- 目标收件人、固定 Topic 真人来源、空收件人默认 @、引用已送达助手回复的对象纠正、旧决定已应用取消动作后的恢复：`node --test --test-name-pattern='多依据普通回复应指向语义接收人|普通回复只接受固定Topic真人来源|普通回复省略或明确空收件人|引用已送达助手回复的对象纠正|旧决定已应用取消动作后恢复' test/topic-runtime.test.js`，11 pass、0 fail、0 skip，736.5143 ms，exit 0。
- Decision 附件读取失败硬拦截：`node --test --test-name-pattern='任务所需附件读取失败时硬拦截任务动作并反馈缺失信息' test/decision.test.js`，1 pass、0 fail、0 skip，344.2592 ms，exit 0。
- 原生通知格式化多收件人：`$env:DSH_NATIVE_TEST_PROFILE='D:/dsh_home/profiles/web/package.json'; node --test --test-name-pattern='普通回复显式多收件人贯穿原生通知格式化' test/task-topic-routing-native.test.js`，1 pass、0 fail、0 skip，2725.3845 ms，exit 0。使用临时 native DB 与通知 send 桩。
- 关联回归 `node --test test/topic-runtime.test.js test/decision.test.js` exit 1；当时输出被宿主截断，无法可靠确认总数。可见旧 fixture 因缺少现合同要求的显式 `replyToMessageId` 返回 `invalid-arguments`，涉及共享来源、任务恢复及审阅路径。该失败保留，不能以定向测试通过覆盖。
- 后续关联回归快照：完整测试共 177 项，174 pass、3 fail、0 skip，5878.6058 ms，exit 1。两项旧 fixture 已按新合同补显式目标且保留原断言；仍有一项共享消息/别 Topic 回复的原期望为 `reply-owned-by-other-topic`，实际得到 `invalid-arguments`/路由错误，待 implement 核对返回合同是否回归。此轮未全绿。

## 证据边界

定向用例使用结构化脚本模型；native 用例使用临时数据库及通知发送桩。结果证明所述本地受控路径，不证明真实 LLM 对自然语言纠正的理解，也不证明真实钉钉送达。notification-only、prepared、revision 恢复组合仍未验证。HEAD `63ab508b502c8d2576a654e9be2f15225031d7ff`；源码与测试改动未提交。

## 状态

仅矩阵逐项有直接证据的定向行为记为 PASS；广义来源/引用/群归属/收件人校验项保持 PENDING：本轮只覆盖固定 Topic 真人来源及定向路由测试中的相关断言，未覆盖引用非助手回复、同名歧义和跨群拒绝。全量关联回归有失败，其他未覆盖项保持 PENDING，不创建最终 `report.md`。不涉及正式库、真实消息、现场通知、部署、合并或 CI。
