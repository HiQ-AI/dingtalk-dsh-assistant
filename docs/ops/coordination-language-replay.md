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
