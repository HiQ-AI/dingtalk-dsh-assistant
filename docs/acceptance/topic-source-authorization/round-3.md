# 本机部署与原话题恢复

2026-10-19 北京时间，按 task-session-clean-start runbook 使用 deploy-task-session-native.ps1，先 Check：writes=0 / signals=0，40 个原生会话静止，unknown operation/notification=0。正式安装前原 PID 62032 经 SIGINT 退出、实际后代=0、端口关闭，离线账与原生日志核验后再安装双包；未创建历史备份。

Assistant 包 D:/dsh_home/packages/assistant-topic-source-authorization-20261019.tgz，SHA256 d4d0dda224f31eab3daee0c80584fe0978631248d51a3dfc5e5e3a79c56ac0bb。保留当前 Observer 的 observer-provider-review-revision-20261019.tgz。安装版本 2.0.1；新 PID 66700，启动时间17:00:00，独立 GET /health 返回 ok / inboundProcessing=true / recoveryIssueCount=0 / dwsBridge.healthy=true。部署工具校验包/安装文件后，另以 Get-FileHash 独立核验两个修改模块与源码相同。

仅一次 POST /config/groups/<原群>/messages/msgfZdslbk8gdTkXI+nQ3li5Q==/retry，之后通过独立 GET 状态和 JSONL 核验，不依赖 POST 回执判断恢复：

- 原决策 coord-decision-d45b5cbfcf63c553efbaa155f5050537e10c665ffad57f4d8d4e8ab521360157 从 blocked 到 completed。
- 原话题 topic-6810ca2c8cddff3f3a1585bb4f909b6b：revision=5 / processedRevision=5 / pendingRevisionCount=0 / processing=null，原三条积压已消费。
- 话题任务仍只有 task-7c7b8c0d7287a6bd0de4e2a2519ba764，status=active，需求版本及 runSequence 均为2；目标为审核详情修复部署UAT2。
- 原统筹 session task-session-6196fe08-c7d5-4d6e-abb7-da18813a1a31 不变，17:01后的 JSONL 有 read、skill、model_content_read；seq269 在17:01:53调用 task_delegate，seq274提交统筹决策。
- 复用原 executionId 8d03a0e8-ceb8-468b-b77f-56302277079c、原执行 session task-execution-4f28a8dd-13cf-4cae-a92b-1e53fa7a8112，status=running / drained=false，startedAt=09:01:53Z。
- 后续决策 coord-decision-f8a8f9d8fbb0397e1690674224b44bd40904de30de6857d7b644ced5d0ddb987 completed：两条追问没有新授权范围，已运行原部署，不重复确认或派发。

控制证据位于本 worktree docs/tmp/topic-auth-deployment-round-1，独立只读摘要 docs/tmp/topic-auth-live-readback.json。以上证明原话题/任务续办，不宣称 UAT2 已部署或业务验收通过。
