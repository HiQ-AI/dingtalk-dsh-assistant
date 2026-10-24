# 第七轮：客户端真实入站与耗时审查

## 状态
真实客户端新消息解除此前DWS自身回声阻塞。已自动创建三个独立Task并启动A，但A终端沙箱权限失败，尚无任何正式完成事件；B/C保持hold。本轮不全绿，不写report。

## 身份
- messageId=msgtrvT+6JRj5yJB5DDwxEAeQ==；群cid2HnVI0zvC2dOr5RmJ5ZCJg==；DWS messages-mget complete=true/foundCount=1/failedCount=0，无messageAiSendFlag。
- coordination-f1767af593d66d5eabe73d31dfbc9a30；安装仍9f41510，未部署或修改配置。
- A=task-cfe4f8e8b0993c6458d8391f9e885516；B=task-3379b3ead0e8713b6df0783f2ec88721；C=task-4d198f4ac51b9830ac50de22ff9e223a。

## 实测时间（北京时间）
| 事实 | 时间 | 相对前项 |
| --- | --- | --- |
| 群消息发送 | 21:07:41.000 | 起点 |
| Resident来源预留 | 21:08:21.408 | 40.408s，含接收/路由，不能全部算模型或传输 |
| Dynamic协调来源预留 | 21:08:22.497 | 1.089s |
| 协调安排创建 | 21:08:50.086 | 27.589s，包含规划/提交，不等于纯模型时间 |
| A启动命令接纳 | 21:08:50.257 | 0.171s |
| A Host handoff | 21:08:51.250 | 0.993s |
| A Owner认领 | 21:08:51.255 | 0.005s |
| 第一次pwsh失败 | 21:09:03.412 | Owner认领后12.157s |
| 第二次pwsh失败 | 21:09:13.841 | 两次失败间10.429s |
| A提交blocked | 21:09:28.640 | 认领后37.385s |

- 从消息到安排69.086s，到A Owner认领70.255s，到blocked107.640s。
- A Owner认领不是独立execution running；当前没有execution行。没有A completed事件，所以A→B/B→C的事件释放耗时不能测得。
- B/C依赖分别指向前member，均有coordinationHold，无B/C occurrence，无task.completed事件；当前没有提前启动证据。

## 已证问题与风险
- 直接阻断：原生session.v4.jsonl的job/settled seq27与39、tool/result seq28与40均为 SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:/baibu-agent/tasks/task-cfe4f8e8b0993c6458d8391f9e885516)。这是终端启动前权限操作失败，不是a.json写入失败，也不是已证协调器依赖故障。ACL归属/沙箱grant实现哪层根因未收敛，未擅自改权限。
- 时延风险：现配置recoveryIntervalMs=5000；resident.js:146-147调用tasks.recover；task-session-service.js:663-695读取完成事件并依次recoverGroup、处理job、再次recoverGroup。task.complete本身没有直接调用该消费者。是持久事件+周期消费，不保证完成后即时唤醒；5秒也不是整体延迟上限。跨群串行await/planner等待可扩大延迟，仅源码风险，尚无本链完成后阻塞实测。
- 需披露的外发分支：任务自动向operator发送了单聊人工求助通知，非指定测试群；notification=operator-request:human-238b4430fdd92ca518dff5ddc92c4aa1ed806058d4548929189c6e57d01d89f5，receipt mid=msgyephe1ChMnePC1O5fnWQHg==，sendAttemptCount=1/state=delivered。lead未直接发此单聊；这是操作人单聊，不是其他业务群；尚无其他群外发证据，不据此判定违反禁止其他群外发的要求，但不能把全过程说成仅群内通知。
- 测量限制：source行只有timestamp，无独立receivedAt，不能精确拆解40.408秒中的传输/路由/排队份额。
- 审计过程问题：lead曾全量读取dynamic_receipts导致独立只读Node审计进程4GB堆溢出，未写库；随后改用SQL按本轮ID过滤成功，未调大堆或重跑全表。该故障不算插件性能证据。当前health=degraded/recoveryIssueCount=1，独立回读告警确认为A blocked而非审计进程崩溃。

## 原始证据
只读SQLite快照与命令收据；原生任务会话session.v4.jsonl；本机docs/tmp/coordinator-abc-validation/current-live/a-detail.json、group.json。原始JSON不入库。
本轮只读分析，没有修复权限、启动B/C、改代码或部署。
