# Host 身份错误的历史渲染摘要

Host 的 `execution_background_identity_missing` 拒绝路径曾将 `Error.message` 文本记入操作摘要，原生工具日志随后将该 Error 渲染为带 `Error:` 前缀的文本。因此即使有精确绑定、成功排空的只读调查，原摘要与原生回执仍无法直接相等。

仅人工调查恢复路径允许识别这一固定映射：shell 工具、账本错误码严格相等、单一原生错误文本严格相等、账本摘要严格匹配无前缀固定文本。没有通用去前缀或任意错误文本兼容。自动恢复和普通上下文读取不启用这一映射。

原调用、参数摘要、会话身份、结果 callId/isError、回合终态、排空、非活跃、无运行作业、精确绑定成功只读调查等门禁仍必须通过。结论仅为 failed 且 partialEffectsPossible，不改原生日志、不改历史摘要、不推断 noEffect、不重放命令。

测试：`node --test test/dynamic-operation-readback.test.js`。新增正例先红后绿，另覆盖错误码/摘要/文本不符、多块内容、非 shell、调查未完成或绑定错误、未排空、异常终态等拒绝情况。
