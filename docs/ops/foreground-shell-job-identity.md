# 前台 shell 输出与后台作业身份

前台 `pwsh` 或 `bash` 可以输出历史 JSON、job receipt 或 `Job ID:` 文本。这些 stdout/stderr 数据不能作为当前调用启动后台作业的证明，否则已正常退出的调查命令会被 Host 误拒绝为 `execution_background_identity_missing`。

Host 只对当前执行建立时固定的原生 shell 定义、未请求后台执行且具备完整 `kind: foreground` 结果结构的调用，将终端文本作为数据。结构化结果其余字段仍检查后台标记；真正的顶层 jobId 仍先经过原生 registry、所属会话及调用绑定校验。同名工具替换、不完整前台结构、后台请求与无 registry 的真实 job 不获得豁免。

回归用原生 ToolRuntime / AgentLoop / JSONL 夹具模拟 foreground 注册与 completed/exit 0 事件，不执行或重放现场命令。覆盖 stdout 嵌套历史 receipt、stderr 历史 JSON、打印 job 文本，以及四种仍须拒绝的输入。既有 unknown 操作继续保留审计，通过既有绑定调查及 operator 流程处理，不能凭 exit 0 改写历史回执。

定向测试：

```sh
node --test --test-name-pattern='terminal native shell|foreground shell exemption|unverifiable.*background|real structured native job' test/dynamic-execution-session-native.test.js
```
