# Round 2：原消息的真实模型回放

2026-10-20。修正验证脚本的 profile 读取后，零写 check 返回：14 个已完成任务，当前模型 `openai-codex / gpt-6.1-sol / low`，无业务派发和钉钉发送能力。

## 观察与断言

回放使用当时原消息及工具 spill 中完整的 14 项任务快照，当前原生 Topic 协调器和真实模型。话题历史裁剪掉原错误路由、旧决策与发信箱；动作执行仅更新隔离内存投影，未调用现场 Task API、GitHub 写入、UAT 或钉钉发送。

真实模型共调用任务目录 3 次、详情 3 次。一次详情请求包含 9 个任务，被原有最多 8 项限制拒绝，模型自行缩小请求后继续；未放宽限制。最终原生提交 accepted，6 个动作全部是 task-reopen，6 个目标均来自历史原任务，没有 new-task、没有重复 taskId，耗时 118540 ms。核对动作正文可见，模型识别共享 PR 的关联交付并避免重复派发；每项都保留先核查 PR/评论状态、适用才修订验证与提测的条件。

本轮证明当前样本下真实模型选择已改变；不证明所有自然语言表达都必然命中，也不证明现场原任务已重开或 PR 评论已处理。执行身份与幂等性由 round-1 的原生服务回归单独验证。

已独立读取 [模型摘要](round-2/model-summary.json) 和原生会话工具提交记录，状态以 [matrix.csv](matrix.csv) 为准。

另外用当时完整目录回执直接调用当前 `taskIndexPage`：14 项全部返回，目录 12270 字节，nextOffset=14、hasMore=false；相比原 177519 字节，不再依靠 Host spill 承载目录。超量时的多页不漏项由 round-1 合成长正文用例覆盖。最终脚本重命名后再次执行语法检查和 `--check`，输出目录 `Test-Path` 为 false，确认零写。

## 再生成

既有 `message-clarification-admission` 回放脚本针对旧 message workflow，无法验证当前 Task/Topic 边界；本次脚本复用 `nativeTaskHost` 与当前协调器，单独保留在本特性 scripts 桶内。

在仓库根使用 PowerShell 7，设置 `DSH_NATIVE_TEST_PROFILE` 为已安装完整 Web profile 的 package.json，`DSH_HOME` 为该实例的 Harness 根。脚本参数分别提供 profile 目录、只读 resident JSON、当时完整任务目录回执、原消息 ID 和新的本轮输出目录：

```powershell
node docs/acceptance/completed-task-followup/scripts/replay-native-task-coordinator.mjs --profile <绝对profile目录> --resident <绝对resident.json> --tasks <完整任务目录回执.txt> --message <原消息ID> --output <docs/tmp/下的新输出目录> --check
node docs/acceptance/completed-task-followup/scripts/replay-native-task-coordinator.mjs --profile <相同profile目录> --resident <相同resident.json> --tasks <相同回执.txt> --message <相同原消息ID> --output <同一新输出目录> --run
```

check 不创建输出。run 的原生会话与动作正文保留在本机 docs/tmp，包含真实业务上下文，禁止提交；只将去除正文和身份的 summary.json 放入本轮目录。模型/provider 从运行实例只读 API 取得，凭据由现有 provider 自行读取，不复制。
