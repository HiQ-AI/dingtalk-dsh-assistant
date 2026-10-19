# 第 7 轮：正式部署及原通知对账

2026-10-19，等待业务执行和统筹自然结束后，独立账本核验 40 个会话排空、未知操作 0、未知通知 1。原生双包部署脚本完整 Check 返回 writes=0、signals=0，目标控制台通过；随后同参数正式切换，SIGINT 退出 PID72024，子进程排空后安装，新 PID62032 双端口就绪。未建立历史备份。

| 核验 | 结果 |
| --- | --- |
| Assistant 2.0.1 包 SHA256 | efc22ec3b31986bec63c8559f1405af3b865cbf1eb0752710248dc9fe279ecba |
| Observer 2.0.1 包 SHA256 | 6c80551e2bafdd73125b20f992390f3d077993c45845b04b705e7c8c6168a5d6 |
| 安装校验 | Assistant 54 文件、Observer 4 文件均与精确包及源码一致 |
| profile 原字节 SHA256 | aa38870b121ee6aec20e7beb69f10ebe79af017a356b4fe9ca177ab916a588fc，未改变 |

原通知 `completion:task-6818916367cb2acf4cce15ddba1be6fd:5` 保留原 openTaskId 和原正文。启动后既有通知回读路径调用正式 notification.reconcile，于 2026-10-19T08:53:54.478Z 将原通知记为 delivered；没有调用发送、重发或手改 SQLite。

API 和独立 SQLite readOnly 查询一致：

- state=delivered，sendAttemptCount=1，部署前后不变。
- messageId=msgeirS0jkArkW4aK66ZUN5Dw==，与部署前 DWS SUCCESS 及原消息读取一致。
- identity=send-receipt，quoteMessageId=msgHrFFRhvew9SV3vRJFM24Sw==，sentAt=2026-10-16T01:41:15Z。
- evidenceRef=notification-readback:2860e3d373a0fb7c027ba3fbae14a2e0070ac50a7479f7bfe46add26ea68a31f。
- mentionVerification=unavailable；没有将纯文本 @ 当作原生提及证据。

再次独立读取 `/state/recovery-issues` 为 []，`/health` 返回 status=ok、recoveryIssueCount=0、inboundProcessing=true、dwsBridge.healthy=true。这些证据证明本次列表通知回读正式结清，不代表接收人已读消息。

原始部署控制证据仅保留本地 docs/tmp/ordered-readback-pack/deployment-round-7，避免将完整现场数据和无关消息写入版本库。
