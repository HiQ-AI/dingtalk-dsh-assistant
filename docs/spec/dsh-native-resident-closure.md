# DSH 原生群聊常驻闭环优化

## 目标

在不复制 DSH Session、Goal、Agent Registry、权限、模型和轨迹机制的前提下，保证群消息从 resident 主会话进入独立叶子执行，并把结果可靠返回原主会话和原群。

## 边界

- 一个外部群唯一绑定一个固定 resident Session；群职责通过 `systemPrompt.section` 注入。
- DWS bridge 只负责接收、去重、排序、发送和回读，不判断是否创建业务 Task。
- resident 主会话只判断、创建或补充 Task、协调阻塞和组织群回复；业务执行只进入 DSH 原生叶子 Session 与 Goal。
- 明确指名仅决定是否允许创建 Task，不扩大动作授权。主会话必须原样保持群消息的动作范围：“看看、查一下、排查、分析、核对、监控”等只创建诊断任务，不得扩写为修复、修改、合并、发布或执行任务；叶子也必须把 Task objective 作为授权上限，诊断任务只提交根因、证据和建议。
- 插件不固化个人数字分身或本机登录人的姓名。Agent 配置保存英文逗号分隔的名称/别名列表；Runtime 同时读取当前 DWS 登录人名称。群消息明确提及任一配置名称/别名、当前 DWS 登录人或使用 `cc:`，才满足任务点名条件。签名和身份声明由 Agent 工作区规则负责。
- 插件 Task 只表示业务排队、执行、等待和完成，不复制 DSH 会话或 Goal 状态机。
- Goal/turn 完成不等于业务完成；结构化结果通过门禁后才完成 Task。
- Task 完成不等于群通知完成；outbox 必须经 DWS 回读确认后才是 `sent`。
- 群图片通过 DWS 下载后进入 DSH 原生 attachment/image block；transport 不做 OCR 或业务判断。
- 活动 Task 使用动态系统提示词投影，不在每条群消息中重复写入快照。
- 任务流程与证据要求属于 Agent 业务配置，只注入叶子系统提示词，不固化在通用插件门禁中。

## 持久化

Task 使用 storage-domain 的独立 KV 表，每个 Task 一个稳定记录。scheduler 只保存工作区、代理和初始化配置，不再保存可被整表旧快照覆盖的 Task 数组。启动时把旧 scheduler Task 一次性投影到独立 Task 表，之后只读独立表。

## 结果协调与发送

- 叶子结果给主会话只投影摘要、提出人和完成交付或缺信息字段，不传完整 evidence/artifacts。
- Runtime 启动恢复期间产生的本进程 outbox 事件，在 DWS listener 挂载后补交。
- 跨进程只重试已完成 Task 的 pending 通知；普通历史回复和旧阻塞不自动重放。
- DWS 最近消息窗口在 `partial=false`、无 failures 时可用于发送前后去重；`complete=false` 只表示更早历史尚未全部翻页，不能永久阻塞最新消息发送。
- Task 保存真实发起消息与提出人稳定 ID；完成通知引用回复发起消息并 @ 提出人。

## 诊断顺序

`DWS consumer → ingress message → resident Session turn → Task KV → leaf Session → Goal → structured result → coordination turn → outbox → DWS message read-back`

任一层失败必须保留该层状态，不以后一层缺失反推前一层成功，也不以页面投影替代真实 Session、Goal 或群消息回读。
