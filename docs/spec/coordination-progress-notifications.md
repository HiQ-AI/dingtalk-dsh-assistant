# 进度询问与协调通知全路径分析

## 目标与现场证据
2026-10-28 用户要求修复重复通知、四个 UPR 事项协调及进度询问过度判断。只读正式 SQLite：D:/baibu-agent/.dsh/task-sessions.sqlite。
- 来源 62759719eaf34f292c69770f883428f58ddc37edeb8c76e737bc67f59481a2a8 原文“@孙鹏(孙鹏) 昨天关于导入的其他问题 修复了没”，09:44:09 建 coordination-7b4d4a667b1dc14fbc3f1d4517e80162，四个无依赖 task-observe。其 commonContext 明确仅询问，不恢复或派发。
- 随后原文“直接查询任务进展就行”09:47:26 建 query 协调指向前述安排。即时答复沿错误观察快照输出四行“原事项”。
- 同一错误安排 summary:2..6 五条 delivered，最后一条 11:02:28 UTC+8 创建，与用户 11:03:25 渠道显示消息内容一致；不把 createdAt 当渠道送达时间。

## 路径与根因
1. 入站来源及 source unit → dispatchOwner=coordination → independent-coordination planner：只有 coordinationIds 的即时 query，无 taskIds 查询出口。
2. planner 把即时询问表示为 arrangement + task-observe；Host 接纳纯观察且无依赖、触发、定时消费者的成员，形成持久协调。
3. observation 不修改 Task，但冻结 requirement/context/control/run 版本。任何维度变化都投影 target_version_changed；文案误称需求已变。
4. Task Owner 与执行实际工作独立推进；blocker 来自当前 lastDecision.summary。已失效观察版本却拼入当前内部诊断。
5. aggregate 以整个 snapshot digest 判断通知变化；内部诊断改写等触发重复群汇总。
6. formatter 所有观察成员固定“原事项”，不带标题，状态和同义 reason 重复；消息扁平展示后像递归套叠。

## 反证与盲点
- 已排除此次摘要递归假说：正式记录明确四个成员各占一行，无上一条通知嵌入的必要证据。
- 已排除此次进度询问直接重派执行的说法：四成员 command.kind=coordination.observe，receiptRef 均空。版本变化的具体来源仍需任务事件核对，不将相关性当因果。
- 传输重试不是五条通知的原因：五个不同 summaryRevision/id，均已 delivered。
- 工程执行和真实 UAT 是否完成不由协调快照判定；本次修复不重做四项业务。

## 实施边界
- 即时 query 支持已读取、同群 taskIds，复用权威只读进度投影，不产生成员、wakes、执行或修订。
- 明确区分询问、催办、追加需求；纯即时查询不得构造持续 observation。无下游消费者的观察安排在 Host 拒绝；合法任务依赖、定时/条件仍保留。
- 观察汇总展示真实标题；失效版本不冒充需求变化，不拼当前 blocker。
- 完整 snapshot digest 保留发送事实 fencing；通知意义单独按业务状态变化去重，不以内部诊断文案/版本变化反复发群。
- 历史错误安排需经精确身份和只读检查进入现有正式取消/退役入口，保留原任务及已送达记录；不直接改 SQLite、不撤回/补发群消息。是否可无外发退役待核对正式接口。

## 验证
覆盖即时四任务查询零任务变更、纯 observation 拒绝、合法依赖/定时/条件、真实新要求、版本 fence、同业务不同诊断无新通知、成员名/状态、发送未知不重放。用真实来源脱敏 fixture 做隔离回放，不能将替身测试当真实模型或渠道验证。
