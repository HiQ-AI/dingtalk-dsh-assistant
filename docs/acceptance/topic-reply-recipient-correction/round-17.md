# Round 17 — 稳定合并基线定向回归

日期：2026-10-29（Asia/Shanghai）

测试源码为未提交的稳定合并工作树：合并前 HEAD 为 `9675c13a36f6aab5cb6545f93481dca833ff3715`，MERGE_HEAD 为最新 main `fd6314606ef176783ac38ed6068945f6ee206626`。唯一冲突已按最终解法暂存；不把合并前 HEAD 原样视为本轮测试版本。

## 结果

以下均为 Lead 确认暂存的最终冲突解决版本，不是此前被拒绝的中间解法：

1. `node --test --test-name-pattern='多依据普通回复应指向语义接收人|普通回复只接受固定Topic真人来源|普通回复省略或明确空收件人|引用已送达助手回复的对象纠正|引用其他人消息或外群助手消息不取得本群回复归属|旧决定已应用取消动作后恢复' "D:/project/dingtalk-dsh-assistant/.claude/worktrees/topic-reply-recipient-correction/test/topic-runtime.test.js"`：12 pass、0 fail/cancel/skip，1608.2497 ms，exit 0。
2. `node --test "D:/project/dingtalk-dsh-assistant/.claude/worktrees/topic-reply-recipient-correction/test/coordination-retirement.test.js"`：2 pass、0 fail/cancel/skip，1632.8269 ms，exit 0。
3. `$env:DSH_NATIVE_TEST_PROFILE='D:/dsh_home/profiles/web/package.json'; node --test --test-name-pattern='普通回复显式多收件人贯穿原生通知格式化|旧回复冻结恢复' "D:/project/dingtalk-dsh-assistant/.claude/worktrees/topic-reply-recipient-correction/test/task-topic-routing-native.test.js"`：5 pass、0 fail/cancel/skip，11681.9089 ms，exit 0；覆盖多 @、prepared、projected、revision-conflict、taskIds-conflict。

4. Lead 独立实跑 `node --test --test-name-pattern='inbox projection startup failure releases the ledger and runtime listeners for retry' "D:/project/dingtalk-dsh-assistant/.claude/worktrees/topic-reply-recipient-correction/test/task-session-http-integration.test.js"`：1 pass、0 fail/cancel/skip，1830.9759 ms，exit 0。坏 SQLite sidecar 导致启动失败后，ledger/runtime listeners 等资源释放，移除坏 sidecar 后可重试启动；不代表全部 inbox 投影路径。

## 最终独立审查

独立只读审查确认 coordinator 相对最新 main 仅叠加本任务的 readFrozenReply 参数、透传和语义收件人提示，未恢复已退役的 coordinationEnabled 或旧进度提示。service 的冻结身份校验、formatter 后保留显式 @、scanner 由 record.operations 派生 taskIds 的发送门禁均保留；main 的协调退役、历史协调通知只投影不发送以及 inbox listener 接入也保留。已审合并路径暂无剩余已证阻断；这是源码审查结论，不替代实跑或现场验收。

## 证据边界

上述四组共 20 个用例是合并后稳定版本的受控定向实跑，不是此前重新引入已退役 coordinator progress prompt 的中间版本。测试使用临时数据、脚本模型和通知桩，不代表全仓、真实 LLM、真实钉钉送达或生产部署。旧 round 的失败/取消历史保留；inbox 仅由第 4 项证明启动失败资源释放及重试，不由前 19 个用例推导通过。prepared 历史超时根因、突然进程 crash 及真实模型消歧仍未验证。
