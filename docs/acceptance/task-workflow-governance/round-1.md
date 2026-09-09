# Round 1 验证记录

## 结论

任务流程已贯通叶子计划、主会话审阅和完成门禁。主会话不能再仅凭自己生成的目标与验收标准批准冲突计划。

## 证据

- `npm test`：271 个测试通过，0 个失败。
- 计划契约：已选流程时必须提交精确 `workflowAssessment.promptRefs`；不适用步骤与例外采用结构化字段。
- 来源门禁：例外的 `basisMessageIds` 必须属于 Task 固定 Topic 原文，伪造或无关 ID 在写入前被拒绝。
- 按需读取：常驻主会话未通过 `group_task_prompt_get` 读完当前流程正文时，`group_task_review_submit` 返回 `prompt-review-required`。
- 冲突处置：模拟“只要求部署 UAT，计划自行增加 UAT 业务 E2E”，主会话返回 `reject`；叶子收到纠偏，旧计划不能推进。
- 修订影响：更新已选流程后，引用任务收到配置更新并在重新加载后要求新计划；未引用流程的任务未收到该更新。

## 本地装配与运行态

- 安装包：`@zzusp/dingtalk-dsh-assistant@0.5.13`，tgz SHA-256 为 `95165B0EE10851CAEB8C3B88A276CE5C437DDBB5119053D316BEE7273471CEC4`。
- 安装一致性：`runtime.js`、`topic-runtime.js`、`store.js`、`task-result.js`、`fake-llm.js` 的源码与 profile 安装文件 SHA-256 逐一相等。
- 进程与端口：同一 Node 进程 PID `314524` 监听 `127.0.0.1:3080` 与 `127.0.0.1:18998`；Web 匿名请求返回认证门禁 HTTP 401，Runtime 状态接口可读。
- 配置保持：`taskPromptsVersion=3`、任务流程共 10 项，安装和重启未改写用户配置。
- DWS 边界：群 listener 与人工回复 listener 均为 `ready`，但群历史回补为 `failed`，错误为 `dws_read_failed:1`，所以 `/health` 为 `degraded`、`inboundProcessing=false`。本轮未发送真实群消息，不能声明真实业务 E2E 通过。
