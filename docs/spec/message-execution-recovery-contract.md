# 消息问答来源与受控恢复合同

## 现状与证据

2026-10-01，真实问答执行已越过消息路由，但附件工具返回 QUERY_SCOPE_DENIED。一条问答虽已加载材料，却使用正文 sourceKey 调用附件；另一条只有可见历史、没有材料读取 scope。workflow-service 的 prepareInput 读取 fullTopic 不存在的 sources 字段，实际 scope 仅含当前消息。工具拒绝本身正确，不能放宽为全群历史读取。

## 修复范围

- workflow-service：使用原生 message.topic.sources 取得当前话题准确绑定来源；复用命令必需材料，并接纳当前请求冻结 snapshot.history 已呈现的同发送者结构化附件。每个附件来源须回读同群、同发送者、同版本、相同正文及精确 sourceMessageId/type/resourceId；普通历史不因可见而授权。沿现有 resolveMaterials 核验来源版本及附件身份。输出明确附件 sourceKey/version/type/resourceId 清单，不以可见历史授权。
- message-agent：复用现有 input/definition 构造，增加只读 retry 准备；新输入与 session 独立，旧尝试和回执保留。
- ledger：扩 message.command.retry.readonly 的 answer 分支，仅当前来源、applied blocked、执行 failed/drained/read-only/execution_tool_failed、无未知效果/运行中通知，CAS 后设置 ready。不得将旧失败伪装 unknown 或重建用户消息。
- HTTP/service：仅现有可信本地 Web 身份可显式发起；先重建当前输入、存 artifact，再原子提交。维护期可排队，执行继续遵守现有维护、来源和租约门禁。
- 通知：新结果按 inputVersion 独立事件，旧 delivered 不覆盖；系统读取失败明确无需用户重复材料。

## Retry 参数

commandId、expectedInputVersion、expectedInputDigest、expectedLeaseEpoch、sourceVersion、expectedRunRevision、retryKey、reason、inputVersion、inputDigest、inputRef、sessionId、toolPolicyDigest。service 从当前账及重建结果生成身份字段，调用者不能指定 scope。retryKey 幂等；旧尝试完整记录在 attemptHistory。

## 验证

精确话题与已选择附件可读；同群任意历史附件、跨群、来源换版/附件错配拒绝。已失败且排空的只读 answer 能以新输入和新 session 重试；成功/运行中/未知效果/过期 CAS 拒绝，旧送达保留、新结果可独立通知。业务成功以新执行结果为准，不以 command applied 代替。

## 完整性反例增补
历史中核验过的附件只提供精确权限与可读身份清单，不一律提前下载。只有当前动作声明的必需材料进入启动前resolve；其他附件由只读工具按需读取，避免无关过期附件阻断当前请求。
