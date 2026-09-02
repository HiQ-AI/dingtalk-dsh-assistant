# Round 1

## 自动化结果

- `pnpm test`：151 项通过，0 失败。
- 关键审批用例连续运行 20 轮：`stress_rounds=20 result=PASS`。
- adapter 用例验证 `event +listen-im --kind all-direct --events message --format ndjson`，且 ready 前事件不交付。
- bridge 用例验证错误引用不恢复；正确引用的无关键词批复会按批准恢复且重复事件只处理一次，明确拒绝语义仍记为拒绝。
- 普通人工处置的实时和历史轮询路径都断言 `decision=approved`。
- 个人 listener 异常退出后建立第二代订阅，健康状态恢复为 `ready`。
- `pnpm --dir packages/dingtalk-dsh-assistant pack` 生成发行包；归档清单包含 `dws-adapter.js` 和 `dws-bridge.js`，SHA-256 为 `070FF869C4DB470BEEE2108312C3776EC833C42FF0FF2FB875BA85BEDFE8F322`。提交后部署包会重新生成并再次记录不可变哈希。
- 提交 `92859f159673b308003165013da14ad6d9498622` 的部署包 SHA-256 仍为 `070FF869C4DB470BEEE2108312C3776EC833C42FF0FF2FB875BA85BEDFE8F322`；安装目录中 `dws-adapter.js`、`dws-bridge.js` 与源码哈希分别一致。
- 本地重启后只有一个 DSH Web 主进程（PID 11676），同时监听 `127.0.0.1:3080` 和 `127.0.0.1:18998`；Web HTTP 200，Runtime `status=ok`、`recoveryIssueCount=0`。
- `/state/dws-bridge` 回读 `healthy=true`，群 listener 与 `humanReplies` 均为 `ready`，代次均为 1，重连次数均为 0。

## 尚待验证

无。本轮代码、产物、本地运行态和真实钉钉引用回复业务链均已验证。

## 真实钉钉 E2E

- 创建独立测试群和常驻会话 `DSH授权回复E2E-20260902`，resident Session 为 `session-group-795cdb78e7ad8ec3d3e615a3`。
- 群消息创建 Task `task-fdbaf11f-2ed6-457e-9a93-db7170f1c2f3`；Task 在删除测试标记文件前进入 `waiting/human-intervention`，申请 `blocker-8024bc0f-faef-4533-8f81-da3184de0b48` 为 `waiting-reply`，此时文件仍存在。
- 对申请消息发送引用回复“按申请限定范围执行，仅处理这个测试文件。”，正文不含“批准”“拒绝”；DWS 发送状态回读为 `SUCCESS`，回复消息 ID 为 `msgNxSyc9SSqsQ2HOaXrnatqA==`。
- Runtime 回读申请为 `answered/approved`、`decisionSource=dingtalk`，保存完整批复原文；`humanReplies.lastEventAt` 同步推进且 listener 保持 `ready`。
- 原 Task 从 `waiting` 恢复并最终 `completed`；独立文件回读为不存在。完成通知 outbox 为 `sent`，并取得真实投递消息 ID。
