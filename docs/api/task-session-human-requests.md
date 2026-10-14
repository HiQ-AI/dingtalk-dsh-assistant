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
