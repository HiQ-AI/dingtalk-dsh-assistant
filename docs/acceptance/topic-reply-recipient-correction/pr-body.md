## 问题与结果

同一 Topic 中 A 提出需求、B 随后补充解释，decision 同时依据 A/B 时，原 Host 从 basis 中取最后一条真人消息，将回复与 @ 一并指向 B；依据顺序不代表语义收件人。脱敏基线实跑 1 项失败：实际 `explanation-b`，预期 `request-a`。

本修复由 Topic 在 decision 中显式选择回复目标和提醒对象，Host 只基于固定请求消息及回复归属校验、冻结并执行，不再以最后依据作者覆盖。收件人纠正可以使用 `actions: []` 加回复，不要求新建、取消或转派任务；确实无需新沟通时仍可保留不回复分支，不强制每次纠正另发一条。

原 schema 本来允许空 actions 加回复，因此问题不归因为“无任务动作不能回复”。本次同时澄清语义指令，而不是添加姓名或纠正关键词判断。

## 实现

- `packages/dingtalk-dsh-assistant/decision.js:42`：回复分支新增 `replyToMessageId` / `atOpenDingTalkIds`；附件不可用的自动失败回复保留显式路由。不回复分支仍独立且严格。
- `packages/dingtalk-dsh-assistant/topic-runtime.js:1039`：持久接纳前复用 `replyRouting`，限定固定 Topic 消息、回复归属及唯一参与者；执行不再使用最后 basis 作者。共享消息属于其他 Topic 时保留原 `reply-owned-by-other-topic` 拒绝合同。
- `packages/dingtalk-dsh-assistant/task-topic-coordinator.js`：说明纠正本助手沟通对象不等于把业务交给他人，不取消原任务，也不放宽已有任务授权。
- `packages/dingtalk-dsh-assistant/task-session-service.js:728`：公共 outbox 边界核对冻结 notification/outbox 的群、Topic/revision、可用任务身份和正文/引用/@；prepared、notification-only 投影和仅 outbox 场景沿原冻结路由恢复，避免旧正文混新对象。
- `packages/dingtalk-dsh-assistant/task-session-service.js:795`：格式化后恢复已经验证的 @ 集合，避免 formatter 的单目标默认值覆盖多收件人。
- `packages/dingtalk-dsh-assistant/task-session-service.js:1332`：独立通知 scanner 在 prepared 或明确未发送可重试状态，同样按原 decision revision、outbound 和 `record.operations` 派生的 taskIds 核对冻结身份，防止决定已阻断但 scanner 仍错误发送。unknown/starting 仍只回读，delivered 不重发。

明确目标后，省略或显式空 @ 数组均沿既有合同默认 @ 目标作者；非空数组必须唯一且来自固定 Topic 参与者。纯 web/internal 可无真人目标，但不因此增加群外发权限。没有完整冻结证据的旧无路由 pending 决定保守阻断，不根据当前消息顺序补猜对象。

共享脚本模型 `test/fixtures/task-session-native-host.js` 的普通确认分支同步提供固定输入中的真人目标，末尾 web/internal 不作为真人目标；无真人则省略。该选择只用于普通测试夹具，不是 Host 生产兜底；多参与人语义反例仍显式选 A 并断言不被最后解释者 B 覆盖。共享 helper 的真实调用分支及相关历史路径另按影响验证，不用局部包装掩盖其余非法测试输入。

## 关键实现

`packages/dingtalk-dsh-assistant/decision.js:42`

```js
  replyToMessageId: z.string().min(1).optional().describe('明确选择固定话题内真人消息作为回复目标；有真人参与者时非空回复必须填写。'),
  atOpenDingTalkIds: z.array(z.string().min(1)).optional().describe('需提醒的固定话题参与者；省略或空数组默认提醒所选目标作者。'),
```

schema 暴露已有消息和参与者 ID，Host 不从展示名猜身份；是否需要目标由实际真人回复接纳边界校验。

`packages/dingtalk-dsh-assistant/topic-runtime.js:1039`

```js
        try {
          const messages = request.messages.filter(message => { const owner = replyTopicForMessage(store.getGroup(groupId), message); return !owner || owner === args.topicId })
          const { target, recipients } = replyRouting(messages, decision.replyToMessageId, decision.atOpenDingTalkIds)
          decision = { ...decision, ...(target ? { replyToMessageId: target.messageId } : {}), atOpenDingTalkIds: recipients }
        }
        catch (error) { return { status: 'invalid-arguments', issues: [{ field: 'decision.replyToMessageId', code: error.message, message: error.message }], nextAction: 'correct-arguments' } }
```

路由非法时在 decision/operation 接纳前返回可纠正参数错误，不先执行业务再发现外发对象不合法。

`packages/dingtalk-dsh-assistant/task-session-service.js:795`

```js
      args = { ...args, ...reply, atOpenDingTalkIds: previous ? previous.atOpenDingTalkIds ?? [] : args.atOpenDingTalkIds ?? [] }
```

已有 outbox 复用原提醒集合，新通知保留接纳时明确的多收件人；formatter 仅处理正文与默认引用结构。

## 验证

- [x] 脱敏修复前基线：`node --test --test-name-pattern='多依据普通回复应指向语义接收人' test/topic-runtime.test.js`，1 项如预期失败，实际引用 B、预期 A；基线没有新增路由字段，只证明旧 Host 的顺序选择，不证明其应推断未提供的对象。
- [x] `node --test --test-name-pattern='多依据普通回复应指向语义接收人|普通回复只接受固定Topic真人来源|普通回复省略或明确空收件人|引用已送达助手回复的对象纠正|旧决定已应用取消动作后恢复' test/topic-runtime.test.js`：11 pass / 0 fail / 0 skip，exit 0；覆盖显式 A 路由、非法参与者、默认 @、纠正时任务保持及旧无路由恢复拒发。
- [x] `node --test --test-name-pattern='任务所需附件读取失败时硬拦截任务动作并反馈缺失信息' test/decision.test.js`：1 pass / 0 fail / 0 skip，exit 0，自动失败回复不丢显式路由。
- [x] 指定 `DSH_NATIVE_TEST_PROFILE=D:/dsh_home/profiles/web/package.json` 运行 `node --test --test-name-pattern='普通回复显式多收件人贯穿原生通知格式化' test/task-topic-routing-native.test.js`：1 pass / 0 fail / 0 skip，exit 0；真实 service 与临时 native DB 贯穿至通知 send 桩，payload 引用 A、@ A/B，recover 不重复发送。未启动正式 profile。
- [x] `node --test test/topic-runtime.test.js test/decision.test.js`：最终 177 pass / 0 fail / 0 skip，6596.2022 ms，exit 0。此前旧 fixture 缺目标及共享消息拒绝状态回归的失败保留于 round-2，修复未删除原断言。
- [x] 来源语义戳定向复验：指定 native profile 执行 `node --test --test-name-pattern='来源语义戳在首次Topic完成后落账' test/task-topic-routing-native.test.js`：1 pass / 0 fail / 0 cancelled / 0 skip，2653.141 ms，exit 0。此前 native + format 关联运行 `bvlzff8n9` 为 37 项中 36 pass / 1 fail（65806.5819 ms，exit 1）：唯一失败的脚本改成 `reason` 分支却残留 `replyToMessageId`，严格 schema 拒绝；最小删除残留字段后保留原落账时序、无任务/通知和幂等断言复验。更早 6 项超时取消保留于 round-5，不算通过。
- [x] 指定 native profile 执行 `node --test --test-name-pattern='旧回复冻结恢复 (revision-conflict|taskIds-conflict)' test/task-topic-routing-native.test.js`：2 pass / 0 fail / 0 cancelled / 0 skip，3594.5996 ms，exit 0。有界等待持久 decision 真实终态后，两项原断言均验证 blocked、精确 `group_reply_frozen_identity_conflict` 及 send=0；错 revision、错任务绑定不能被独立 scanner 投递。此前错误外发反例及 round-9 过早读取 accepted 的失败分别保留，不覆盖历史。
- [x] 合法 prepared 恢复：指定 native profile 执行 `node --test --test-name-pattern='旧回复冻结恢复 prepared' test/task-topic-routing-native.test.js`：1 pass / 0 fail / 0 cancelled / 0 skip，4259.4232 ms，exit 0。补生命周期诊断及有界终态等待后，当前一次恢复断言通过；round-9 的 30 秒取消无调用栈且根因未证，保留为历史不稳定性风险，不声称已证明其根因。helper 表与 projected 在 round-9 中通过。
- [x] 引用身份与群边界：`node --test --test-name-pattern='引用其他人消息或外群助手消息不取得本群回复归属' test/topic-runtime.test.js`：1 pass / 0 fail / 0 skip，878.6744 ms，exit 0。同名展示不替代稳定 ID；他人消息/外群已送达通知引用不取得本群助手回复归属，外来收件人被拒且外群账本不变；不证明真实模型同名消歧。
- [x] 三处手写决定调用方：指定 native profile 执行 `node --test --test-name-pattern='real coordinator input enforces explicit context semantics|web acceptance reuses existing topic|Host exact recovery rejects unknown effects' test/task-session-service-native.test.js test/task-web-topic-reuse-native.test.js test/task-background-retry-native.test.js`：6 pass / 0 fail / 0 cancelled / 0 skip，39308.2232 ms，exit 0。仅补当前合法显式路由，保留 missing/preserve/replan/cancel、原图 Topic 复用及前效果恢复原断言。
- [x] 完成/阻塞代表路径：指定 native profile 执行 `node --test --test-name-pattern='完成及状态末尾统一署名|a native blocked decision without a human question' test/task-session-reply-identity.test.js test/task-session-human-native.test.js`：2 pass / 0 fail / 0 cancelled / 0 skip，9524.1469 ms，exit 0。完成/状态的署名、引用和真实 @ 不变，blocked 决定形成持久明确请求并保留原任务继续能力。
- [x] 通知恢复代表路径：指定 native profile 执行 `node --test --test-name-pattern='notification service manual unknown recovery is readback-only|manual notification recovery of starting and legacy guard-unknown remains readback-only|deferred service confirmation persists ACK, recovers after restart and never resends|native service reopens an unknown notification for readback without resending' test/task-session-http-integration.test.js test/task-notification-delivery.test.js test/task-session-service-native.test.js`：6 pass / 0 fail / 0 cancelled / 0 skip，13724.6618 ms，exit 0。starting/unknown 只回读、ACK 重启不重发，native unknown 不重放已完成业务；不代表全部通知组合或实际钉钉送达。
- [x] 材料历史真实 group ingest/helper 路径：`test/task-session-material-history.test.js` 的 `source text and actual attachment bytes are materialized` 在全新临时工作目录运行，1 pass / 0 fail / 0 cancelled / 0 skip，5968.4886 ms，exit 0；源文本及附件材料复用而不重复下载。完整隔离执行命令见验收 round-14。
- [ ] 真实 LLM 自然语言消歧、真实钉钉送达、正式数据库及进程 crash 验收：未执行，不属于本次本地受控验证结论。

## 风险与边界

独立只读审查截至当前已审源码及测试暂无剩余已证阻断。三处非 helper 迁移仅补路由，保留 missing-mode、原图来源版本和 unknown/stale/CAS 等原断言；其中单真人夹具的末条选择不证明多参与者语义选人，多参与者行为由显式 A/B 专项验证。审查和代表路径通过不等于全部组合全绿。

这次是 Host 路由/schema/通知恢复修复，不是全套跨 Topic 主回复架构。结构化模型和发送桩证明执行合同，不证明真实模型总能正确理解昵称或任意纠正表达。引用背景本身不授予跨群/跨 Topic 选人权限。

旧 pending 无可信冻结路由时需要对账或重新决策，不沿新默认重选。历史 notification 没存的任务版本字段不能声称已完整验证。既有 sent/superseded 与 unknown/readback-only 的发送状态合同保持；恢复验证使用临时数据、受控发送桩及优雅重开，不能推广为所有进程 crash 或外部平台送达状态都已验证。

不含数据库 schema 迁移；不操作正式库、不重放真实消息、不补发/撤回通知、不部署、不合并、不触发 CI。回滚前须暂停新接纳并对账未完成决定与冻结通知，不能删除账本或重放已成功发送。
