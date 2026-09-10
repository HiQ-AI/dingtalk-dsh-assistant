# 协调修复性能测量

## 测量边界

所有模型请求使用当前安装的 DSH `LlmRuntime`、`dsh-codex-connect@0.1.0-alpha.4.30` 及本机现有账户认证，模型为 `openai-codex/gpt-5.6-sol`、reasoning effort `low`；当前运行态 `/state/agent-config` 已独立确认相同选择。脚本不输出凭据，不修改配置，不提供工具；消息、Task 和审批均为合成数据，commit 仅写入内存测试收据。

这些结果不包含 Topic 路由、真实审批、真实任务执行或 Outbox 到钉钉发送时间，不能作为端到端 P95≤30秒已经达标的证据。每轮结束的 JSON 保留原始计时和 usage；失败与成功分开统计，不丢弃失败样本。

## 真实模型第一轮

命令：`node docs/acceptance/resident-leaf-coordination-repair/scripts/status-model-benchmark.mjs --samples=30 --output=model-benchmark.json`。

- 状态问答30次：成功21次，9次因 `model_incomplete` 安全转交；额外新SQL执行反例正确转交1次。
- 成功请求 P50 **14.667秒**，P95 **19.388秒**；成功请求输入均为 **839 tokens**。
- 9次失败耗时 **1.007–3.305秒**，适配器回报 input/output/total usage 均0；不能把这些快速失败视为成功加速。
- 此轮尚未记录原生 finish kind/code，不能追溯断言具体 Provider 错误。后续保留此盲点，不能根据新轮通过倒推旧失败根因。

canary文件 `model-benchmark-canary.json` 的真实模型调用成功，但该进程末尾因误用 `ctx.dispose()` 清理失败；脚本已改用原生 `ctx.fiber.dispose()`，第一轮30样本进程退出码0。

## 失败诊断与同因修复

1. 原生 `dsh-llm-retry` 只监听 `agent/request-error`。直接调用 `LlmRuntime.stream()` 不经过 AgentLoop，因此原短问答实现没有执行 Provider 的原生重试策略。
2. 原生插件未导出独立重试执行器，短问答现通过 `prepareCall()` 捕获相同 Provider policy，在唯一 handler 内执行有界重试；保留 retryableCodes/maxRetries、Retry-After、指数退避和抖动。所有尝试共享原请求ID、输入消息ID和总30秒预算，失败部分正文不提交，不向常驻逐次重复注入上下文。
3. 已加入安全 `modelFinish={kind,code,status}` 与 retry 事件；不记录原始 Provider 错误正文。确定性测试覆盖临时失败恢复、非重试码、次数上限、整体超时、累计 usage 和同输入身份。
4. 已检查当前安装的 `pi-ai/dist/api/openai-codex-responses.js` 371–429行：请求体未序列化 maxTokens/max_output_tokens；Codex Connect 也未额外添加此字段。因此目前没有证据将本轮失败归因为2048推理输出上限，未据此盲改参数。
5. 仅增加 finish 遥测、尚未加重试的诊断轮10次状态查询全部返回 `stop`，额外执行反例正确 handoff。这不证明此前9次失败已经修复，也不替代下面的独立修复后轮次。

## 加入原生policy执行后的独立轮次

命令：`node docs/acceptance/resident-leaf-coordination-repair/scripts/status-model-benchmark.mjs --samples=30 --output=model-benchmark-after-retry.json`，进程退出码0。

- 30次状态请求：29次返回 `reply`，1次正常 `stop` 后选择 `handoff`；技术失败0次。全部请求 `attempts=1`，没有真实重试事件。
- `reply` 分支 P50 **11.796秒**、P95 **16.990秒**；30次状态请求的输入usage均 **839 tokens**。额外新SQL执行反例正常拒绝新动作并转交，耗时7.530秒、输入838 tokens。
- 第18条的转交原因是“快照未明确标识第18个候选”。这是合成fixture的身份歧义：问题指定候选编号，快照却只说“生产候选”。该转交不能计为Provider失败，29个reply分支也不能仅凭输出结构认定业务内容全部正确。历史JSON中的 `correct` 仅比较期望分支，不是语义正确性证明；本轮没有保存29份reply正文，不能补造准确率。
- 第一轮与本轮保留独立统计。本轮未出现可重试原生错误，因此**不能把21/30到29/30的分支变化归因于重试修复**，也不能宣称此前9次错误已被真实恢复。重试分支由确定性测试证明，生产错误种类仍待实际遥测确认。
- 已修正可再生脚本fixture为 `candidate-bound-v2`，在问题和快照内显式绑定同一candidateId，并为未来运行保存合成reply正文；按照本轮收口要求没有额外真实重跑。现有JSON来自旧fixture，不能误标成v2结果。最后补充的异步配置解算共享30秒deadline只做确定性测试，本轮使用同步配置，不覆盖配置阻塞场景。

因此本次实测支持“简单模型调用可以在约12–17秒返回”和“重复正文显著减少”；端到端30秒目标、真实Provider故障恢复成功率、以及语义回答准确率仍没有由本组基准完全验证。

## 五次审阅的正文重放对比

命令：`node docs/acceptance/resident-leaf-coordination-repair/scripts/context-replay-benchmark.mjs`。

脚本从真实 `git show b7d0ea1:packages/dingtalk-dsh-assistant/topic-runtime.js` 装载基线协调器，与当前协调器运行相同合成 Store 和原生 Session，独立重放10轮，每轮5次审阅。共享 Store 是刻意控制的测试底座，本结果只比较协调协议，不宣称整个旧版本端到端执行表现。

| 每轮实测 | 基线协调器 | 当前协调器 |
| --- | ---: | ---: |
| 流程读取工具调用 | 5 | 1 |
| 相同长原文分页调用 | 5 | 1 |
| 流程正文字符 | 42,000 | 8,400 |
| 长原文字符 | 52,510 | 10,502 |
| 两类正文合计 | 94,510 | 18,902 |

10轮均得到相同计数，正文与上述工具调用减少 **80%**。最终记录包含基线/当前协调器源码SHA256；Host 合成重放当前耗时4.50–18.36毫秒（P50=5.22毫秒），基线1.76–4.42毫秒（P50=2.64毫秒）；可信可见性核验增加了本地开销。减少的是重复模型上下文与工具往返，**没有实测证明Host计算本身更快**，也未将其外推为模型墙钟缩短80%。

## 可再生与诊断

- 只读自检：`node docs/acceptance/resident-leaf-coordination-repair/scripts/status-model-benchmark.mjs --check`。
- 真实模型脚本允许 `--samples=1..30`、`--output=<本验收目录内文件名>`，一次运行另外附带1个新动作 handoff 反例。
- 基线重放模块从 Git 对象临时生成，用后删除；完整计数保存在 `context-replay-benchmark.json`。
- 第一轮、诊断轮和修复后轮分别保存，禁止混合成功样本美化P95。
