# 同账号授权恢复及错误澄清撤回

2026-10-08，用户再次完成授权，并提供同窗口 `auth status`：authenticated/token_valid/refresh_token_valid 均 true，access 到期 13:09:11 +08，refresh 到期 11 月 7 日。用户和工具侧均是相同路径、v1.0.63 commit、明确同一 profile；工具侧与旧后台仍读到 10 月 6 日期限。因此先前“新登录未保存或被覆盖”不是已证明根因，现场证据支持启动环境读取差异。

## 恢复服务

- 零写预检：唯一旧 PID 108772，maintenance inactive、drained=true，控制快照成功；无活动节点、Owner、effect、message。
- 通过原生 maintenance enter/seal 取得绑定旧进程的停机许可，保存控制快照；核验 PID 创建时间后停止旧实例及其 DWS 子进程，双端口清空。
- 启动现有 `DSH Web Local` 计划任务，没有修改其配置，没有复制或手写凭据。新 PID 70320；两个群 listener ready、backfill ok，humanReplies ready，health ok、inboundProcessing=true。
- `check-repair-deployment.mjs verify` 独立结果：verified=true、tasks=1、oldNodes=30、oldRuns=1、legacy=0；随后原生 resume，独立回读 maintenance inactive。
- 此对照证明原启动路径与异常有关，不足以确定 Windows 底层隔离、缓存或注册表视图的具体机制。没有根据目录时间或本地 readonly authenticated 字段宣称在线成功。

## 指定消息撤回

沿上一轮已准备的两个 notification operation 顺序 execute；每次由运行服务内 DWS 执行并回读，随后用只读 SQLite 连接独立读取通知账和操作账：

| 操作 | 操作状态 | 通知撤回状态 | 独立回读证据 |
| --- | --- | --- | --- |
| recall-clarify-d48f8c-20261008 | completed | recalled | sha256-aacda72f4365707d15e53f2d727839ce896b3a205ae572c1aa6dbb69f2f60166.json |
| recall-clarify-1e3e3c-20261008 | completed | recalled | sha256-53aba15985b78aff05053d8737cf9131226cd4055c3b771586f0a90768b4d151.json |

额外调用 reconcile 被合同拒绝 `MESSAGE_NOTIFICATION_OPERATION_RECONCILE_REQUIRED`：已 completed 操作不再进入未知状态对账。未因此重发撤回，独立证据以只读账本及既有 DWS 回读工件为准。

## 原来源恢复与新阻塞

两个原来源分别仅调用一次 reprocess：旧请求已 superseded，生成 sourceVersion=2：

- #122 → msg-replay-0f8279566286d33e93e02382b4597a201bec3ba1。
- #125 → msg-replay-6296742c3febd7a4a4c87a918363478832180b62。

两次 HTTP 返回 `GROUP_COORDINATOR_NO_DECISION`，独立 GET 证实新来源已落账且 pending。不能将 HTTP 错误当作零副作用重复重放；不能把解除旧等待当作已创建任务。下一轮诊断协调器真实会话，不再向用户索要业务澄清。原始日志位于本工作树 docs/tmp/dws-login-investigation，不入库。

随后独立回读原生会话 seq 1843/1845、1856/1858：turn 25/26 均为 `PI_AI_ERROR`，正文首行为 `Codex error: Our servers are currently overloaded. Please try again later.`。原生失败被 session 折叠成 no_submission，进而归 condition。两个新来源仍无 commands、无新 requests，当前 compactPolicy 已包含 Host 准入说明。故本轮恢复阻塞是上游模型过载及错误分类缺口，不是再次缺少业务澄清。
