# Round 16 — 最终受控范围映射

日期：2026-10-29（Asia/Shanghai）

## 具体代表用例

- 来源语义戳：`$env:DSH_NATIVE_TEST_PROFILE='D:/dsh_home/profiles/web/package.json'; node --test --test-name-pattern='来源语义戳在首次Topic完成后落账' "D:/project/dingtalk-dsh-assistant/.claude/worktrees/topic-reply-recipient-correction/test/task-topic-routing-native.test.js"`，1 pass、0 skip、2653.141 ms，exit 0。
- 引用身份边界：`node --test --test-name-pattern='引用其他人消息或外群助手消息不取得本群回复归属' "D:/project/dingtalk-dsh-assistant/.claude/worktrees/topic-reply-recipient-correction/test/topic-runtime.test.js"`，1 pass、0 skip、878.6744 ms，exit 0；验证陌生 at ID 拒绝、外群 outbox 不变及非助手/外群引用不取得本群归属。受控 Host 边界，不证明真实模型同名消歧。
- 来源、引用和群归属的更宽定向：round-4 的 6 pass 覆盖共享消息主 Topic 归属、固定 Topic 真人来源和四类非法路由；不扩展跨群授权。
- ordinary confirmation 的代表证据来自 round-2/3 的 11 项普通回复/旧决定断言、round-13 的四种 coordinator context mode 和 native 多 @；不据此声称所有普通确认路径通过。
- completion/blocked 代表证据为 bf23i9l28 的两个精确用例：完成/状态署名保持引用和真实 @；blocked decision 转为 durable request 并续接原任务。
- 幂等/恢复代表证据为 prepared round-11、revision/taskIds 冲突 round-10 的 `send=0`、round-15 的 6 项通知只读回读/不重发；round-8 错误外发和 round-9 异步时序失败保留为历史记录。
- 默认 @ 与多收件人由 round-2/3 的定向结构化/native 测试覆盖；冻结 payload 由 prepared 与冲突恢复定向测试覆盖，旧 pending 仍沿冻结内容，缺证据时不重新推断。

- 冻结恢复同时采用 round-9 中已通过的 projected 子用例与 round-11 prepared 定向；round-9 整组仍是失败，不改写为全组通过。缺少路由且无冻结 payload 的旧决定由 round-2 的“旧决定已应用取消动作后恢复”验证拒发及不重复动作。

## 最终独立审查

review 已回传最终只读结论：截至已审源码及测试暂无剩余已证阻断。三处非 helper 迁移只补路由并保留原断言，故意非法/legacy 负例未机械迁移。单真人夹具的末条目标选择不证明多参与者语义，多参与者行为另由显式 A/B 专项证明。Lead 已独立回读关键 diff、原始后台结果及本轮证据映射。

## 收口边界

以上均为本地受控 Host、临时数据库/通知桩或静态合同证据；不代表真实 LLM、真实钉钉送达、生产库或 sudden-crash。历史 FAIL/取消不覆盖，未运行的通知组合不推导通过。prepared 历史一次超时根因未证；fixed-topic 空 refs 为本次未扩修的基线疑点。最终受控范围已具备报告条件，不等待已结束的审查或重复运行已绿测试。
