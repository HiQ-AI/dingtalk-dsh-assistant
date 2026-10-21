# 协调语言隔离回放

此入口用于语义评估，不提交任务、不连接通知发送器，也不向适配器提供 TaskStore、Host、群历史或凭据。
固定样例使用合成任务 A–F、原安排 ordinal、同名成员和明确的模拟时钟，不包含生产内容。

不带模型适配器时，只生成未执行报告，不搜索本机凭据，不将脚本结果算成真实模型通过：

```powershell
node scripts/coordination-language-replay.mjs --output /tmp/coordination-language-report.json
```

需要真实回放时，先明确模型调用范围及已有授权，准备本地 ESM 适配器，再显式传入：

```powershell
node scripts/coordination-language-replay.mjs --adapter /approved/path/isolated-model.mjs --output /tmp/coordination-language-report.json
```

适配器导出 `identity`、`evidenceKind`（`actual-model` 或 `scripted`）以及异步 `plan({message, context})`。
`plan` 返回现行 `coordinationProposalSchema` 提案；入口校验 schema 后按样例预期字段评分。
适配器看不到预期答案。它必须仅使用已授权模型及只读合成上下文，不加载业务工具或外部发送能力。
脚本适配器只能验证回放器与状态合同，不证明真实语言理解质量。

报告保留逐样例提案、错误字段与失败原因；未执行、未支持能力和模型失败须分开报告。
样例不是昨晚用户原话的完整留存副本；原始六任务消息未在当前上下文提供，合成六项案例不能冒充原话回放。
模型身份、token/cost 统计须来自实际提供方回执，不能由样例数推算。

## 已核查的标准接入选项

安装的 native test profile 提供真实 DSH `ctx.llm` 服务 API，但测试 Host 只注册
`native-task-test` 脚本适配器；不能据此推断已有可调用的真实账号。
只读核查了公开依赖清单、公共 API 和测试组成，没有读取 credentials 文件、环境变量值或执行模型调用。
`dsh-base` 包含标准 LLM registry 及 pi-ai/deepseek provider 依赖；provider 安装、账号可用性及模型可用性是三件不同的事实。

可复用 `scripts/coordination-standard-model-adapter.mjs`，向工厂显式注入**已经获授权的隔离 LLM-only runtime** 的 `ctx.llm`，不启动完整 resident、不挂载 TaskStore/消息/通知/业务工具。
工厂构造不加载配置或凭据、不调用模型；仅显式 `plan` 时调用标准 `resolveCallConfig` 和 `stream`，不自行重试。

```javascript
import { createStandardModelReplayAdapter } from './scripts/coordination-standard-model-adapter.mjs'
import { replayLanguage } from './scripts/coordination-language-replay.mjs'
import { readFile } from 'node:fs/promises'

// ctx.llm must be supplied by an explicitly approved isolated standard runtime.
// Do not load the production resident profile to obtain it.
const adapter = createStandardModelReplayAdapter({
  llm: ctx.llm, provider: selectedProvider, model: selectedModel,
  reasoningEffort: selectedEffort, maxInvocations: 16, timeoutMs: 30000,
})
const fixtures = JSON.parse(await readFile('./test/fixtures/coordination-language-cases.json', 'utf8'))
const report = await replayLanguage({ ...fixtures, adapter })
```

最小授权选项：选择一个现有、可用且已连接的 provider/model，授权最多16次标准 stream 调用，仅发送固定16项合成消息、合成任务/成员/时间上下文及当前提案 schema，不发送真实用户/群消息、附件、仓库私有源码、凭据或任务历史；不执行工具、不发群消息、不改任务。
可先授权4项（六任务、A后B、部分指代、明早9点）小样，再决定是否执行其余12项；工厂 `maxInvocations:4` 限额适用于选出的4项 fixtures。
模型可选择已连接的协调候选模型与一个对照模型；每多一个模型需另算最多16次调用，不能从 Owner 默认 astra 自动推导授权。

当前唯一模型回放外部前置条件是：明确选定且获授权的真实模型接入。无需提供或新增宽泛凭据配置。
工厂记录标准 stream 次数和提供方 usage 事件；提供方内部重试/网络请求数与未返回的成本保持未知，不用16个样例推算账单。
工具调用、无 stop 终态、超限输出均报告失败，不切换模型或扩大数据范围。
