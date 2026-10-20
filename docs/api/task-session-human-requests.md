# 任务会话人工介入 API

本接口属于当前任务会话运行时，旧 `/authorizations/:id/decision` 工作流写入仍退役。

## 读取

`GET /state/authorizations` 返回当前任务持久介入记录。新记录 `taskSessionRequest=true`，包含 `requestId`、`taskId`、`groupId`、`objective`、`question`、`reason`、`evidence`、`attemptedActions`、`requirementRevision`、`controlRevision`、`createdAt`。`status` 为 `waiting-reply`、`answered` 或 `superseded`。已答记录另含 `reply`、真实 `actorId`、`sourceId`、`decidedAt` 和 `decisionSource`；答复不等于批准其他操作。

`audience` 为 `operator` 或 `requester`，未分类的旧记录按 `operator` 展示。技术问题使用 operator：Web 入口保持可用，当前登录人的私聊通知通过原生通知账发送/独立回读，不进入业务群发件箱。记录另含 `notification.notificationId/state/delivery`；只有 delivered 才有可信私聊身份。业务信息问题必须显式选 requester 才发到原群。群补充不能回答 operator 技术申请。

私聊引用由现有 DWS 监听和历史补拉接纳，无新增公开写 API。必须引用该申请原通知，并匹配私聊会话和送达收据中的真实登录人身份；当前申请和需求/控制版本仍须有效。合法答复保存原文来源，`decisionSource=private`。错误作者、群聊、引用、过期申请均不恢复任务；重复事件不重复回答或执行。

## 答复

`POST /tasks/:taskId/human-requests/:humanRequestId/reply`

```json
{
  "requestId": "本次提交的稳定幂等ID",
  "reply": "针对该问题的原文答复",
  "expectedRequirementRevision": 1,
  "expectedControlRevision": 1
}
```

仅接纳本机受信 Web 请求，身份取服务配置 `webActorId`，请求体不能选择作者。`reply` 必填，最长20000字符。成功200返回当前Task DTO，并可靠唤醒原任务；有待办唤醒而原统筹尚未调度时也归执行中。相同请求重试复用原收据，不重复回答或创建任务。

400：缺字段、空答复或不合法输入。403：非本机/不受信Origin/不允许的真实作者。404：任务或申请不存在。409：旧版本、任务未排空、暂停/终态或申请已答/失效。错误不删除原答复草稿；获取当前事项后再处理，不换身份重放。

## 状态语义

`task_request_human` 登记待答问题并结束统筹回合。任务归等待中，执行结果可以落账但不驱动统筹绕过人工等待。收到合法答复后保留原文来源并沿同一任务/会话继续，未知外部效果仍须原生证据对账。普通修订、取消、完成使旧申请失效。等待受控小目标本身不创建人工申请，仍归执行中。


## 操作人结算已结束原生失败

`POST /tasks/:taskId/human-requests/:requestId/reply/check` 使用与reply相同的严格正文，新增可选 `nativeFailureResolutions: [{operationId, expectedOperationDigest}]`，最多8项且身份不可重复。受信本机Web及已配置webActorId必需。Check只读、无恢复或API重放，返回原响应/正常turn结束序号、绑定调查数和failed/partialEffectsPossible预检快照；不能承诺提交时状态不变。

正式reply只对当前operator申请接受该字段。Host核验原isError、精确参数/结果/会话摘要、正常回合结束、无活跃job及已结束绑定只读调查；单个持久事务记录来源、全部指定失败、申请答复和来源路由，任一项漂移整批回滚。结果保留previousObservation、proof、operatorSourceId和partialEffectsPossible；不声明noEffect、成功或新业务授权。模型的task_operation_reconcile不调用这条人工路径。

## Web话题续办与历史归并

Web新建/补充/重开/取消在提供有效topicRefs时复用首个话题，新增Web原文及独立decision/operation身份；其他refs保留为来源背景，不能据此把一个任务补充复制成多个业务动作。隐式继承的refs沿原任务绑定解析到当前版本并将已归并话题映射去重，显式传入版本仍严格校验。活跃决策不允许覆盖；取消仅沿原有blockedReservationsOnly规则处理已经阻塞的保留项。

本机 `POST /runtime/task-topics/reconcile/check` 正文 `{groupId}`，零写返回可归并旧Web续办的精确关系和expectedDigest。正式 `/runtime/task-topics/reconcile` 正文 `{groupId,requestId,expectedDigest}`，原子迁移当前话题归属并关闭来源重复话题。仅识别旧web-task-input单来源单已完成续办、原task明确applied及唯一原群话题，拒绝活跃任务/执行、未处理消息/决策、保留项和摘要漂移；空计划拒绝apply。

原消息/决策/operation/task身份与旧话题版本保留；新版本为来源remove、目标add并直接processed，不重新路由或执行旧意图。来源记录mergedInto及mergeReceipt；任务旧refs仍是有效历史快照。默认GET /state/topics及群进度排除已归并话题，`includeMerged=true`可读归并档案，按ID读取旧版本仍可审计。

归并后的话题上下文按来源消息sequence稳定排序；归属变更的较晚revision不能把早期消息挪到后续指令之后，同一消息的多个单元保持原有稳定顺序，旧revision仍只读取当时归属。

人工请求内容约定：reason简短说明已完成、尚未完成及具体缺口；question提出必要决定，并解释相关既有授权为何不足；完整文件/摘要/过程放evidence和attemptedActions。使用真实换行。来源投影保留原始授权来源及最近19条已接纳来源，不把作者与最初owner不同视为无关；实际权限仍逐条按真实作者和原文判断，完整目录保持可读。技术答复的范围限定不自动撤销先前授权。

本机任务会话模式支持 `POST /tasks/:taskId/reopen`，正文为 `{requestId, context, expectedRequirementRevision, expectedControlRevision}`。仅当前配置的受信本机 Web 身份可调用；只重开已完成且排空、无未结算操作的原任务。保留 task/session/topic 和历史效果，新来源及 runSequence 递增；相同请求幂等，版本漂移返回409，旧工作流入口仍410。交接前须盘点总任务已发生效果并停用其后续执行，再逐项补入剩余增量，避免重复提测。
