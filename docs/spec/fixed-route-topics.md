# 固定话题路由类别

Task-session 的 Route 保留普通业务 Topic，同时提供两个稳定类别：职责外话题（out-of-scope）和职责内Agent平台相关（agent-platform）。类别通过 source unit 的 fixedTopic 字段保存，不是可新建、合并、关闭或续办的业务 Topic。分类仍由现有 Route 根据本群职责和原文语义完成，没有新增分类模型或关键词名单。

插件在打开存储时为已有群自动补齐持久化的 `group.fixedTopics`，订阅新群时一起保存两个固定项，不等待第一条消息或人工添加。归属键为 `(groupId, topicId)`，重复启动与并发订阅不重复创建，已有创建时间保持不变。独立固定项不写入业务 `group.topics`，也不参加业务 Topic 的合并、关闭和任务动作。

看板通过 `GET /state/fixed-topics?groupId=…` 读取上述固定项，在业务 Topic 前固定显示两个入口；没有分类消息时仍可打开空状态。`GET /state/fixed-topics/:topicId?groupId=…&offset=0&limit=25` 按原消息/unit 归属返回处理记录，支持全部群聊或单群筛选、`pageRevision` 校验与最多 100 项的分页。Resident 启动和提交群记录后维护仅含身份与排序信息的内存索引，GET 先取当前页身份再投影正文与回复，不遍历全部历史消息。记录区分待处理、消息处理异常、沉默、回复已准备和后续归类替代；回复沿用发件箱送达状态，不将“已准备”显示成“已送达”。

明确的人工纠正使用本机配置 API `POST /config/groups/:groupId/fixed-topics/out-of-scope/corrections`，仅接受 loopback Host/Origin 身份。请求为 `{requestId, reason, routingRevision, messages:[{messageId,messageVersion}]}`，一次最多 20 条，目标固定为职责外话题且静默；不是自动模型重判或重试执行。先用现有 `GET /state/groups/:groupId/messages?offset=…&limit=…` 获取真实消息 ID、版本与该页 `routingRevision`，不能把序号当 ID。服务端一次群记录提交保存人工 receipt、原处理状态/错误、所有新固定 unit 归属及处理完成；旧 unit、Topic 决策和已发通知留档。普通 Topic 追加移除关联，已空且没有任务引用的孤立 Topic 关闭；其他 Task 不变。看板标明“人工归类纠正 · 保持沉默”及原因。重启/重复 requestId 不重放，同 ID 异文拒绝；来源版本或路由版本过期返回 409，应重新读取确认；存在未完成决策、未结算协调来源或相关待发通知返回 busy，不能强制绕过。该入口不调用 DWS、模型、任务或通知发送，也不调度 Route，普通自动流程仍按真实 mention 证据处理。

本次 #416–422 的人工纠正理由是用户明确要求“这批消息应该都是职责外话题”；必须一次提交七个实际消息 ID，返回 `kind=manual-fixed-topic-correction`、`fixedTopic=out-of-scope`、`reply=silent` 后再回读固定页及旧 #419 Topic。操作不依赖未知的 @ 元数据，不发送补充群回复，不执行“重试几次”的业务。回执保留旧误判证据，不能描述成模型自行得出的结论。

职责外 unit 不进入 Topic Decision 或 Task Owner。真实 mention 元数据证明被 @ 时，通过原通知链准备“这个不是我负责哦”；否则直接结算该 unit。事件缺少元数据时，生产适配器按本群、原消息时间窗口调用 DWS chat message list-mentions，逐页核对原消息身份。读取失败保持未处理并报告错误，不能凭文本里的 @ 名称推断原生提及。

mentions 读取兼容标准 `result.conversationMessagesList[].messages`（`openMessageId`/`messageId`）及原有 `items`，按会话与消息身份精确核对，并复用 `hasMore`/`nextCursor` 续页。百部 DWS v1.0.63 的 [同版本分页实现](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/4cd5d05393a8748e89d9265eb9f7ec85745a0331/internal/helpers/paged_command.go#L259) 和 [空末页测试](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/4cd5d05393a8748e89d9265eb9f7ec85745a0331/internal/helpers/paged_command_test.go#L401) 明确允许会话列表在末页省略；适配器仅在成功且 `hasMore=false` 时接受此形式。非末页缺列表、显式损坏的列表、失败响应、解密失败、部分结果、缺少或停滞的续页游标仍报错。

平台整体问询使用独立原生 session。只暴露 platform_task_query 与 platform_reply_submit，没有文件、shell、创建、唤醒、取消、完成等权限。工具读取本群真实任务（包括同库归档），按状态和本地完成日期查询；列表分页返回 nextCall，提交前检查已发起查询的所有页读完。平台会话只准备答复，不创建业务 Task；修改管理请求只能说明只读能力边界。具体业务进展如“UPR导入修好了吗”仍归业务 Topic；混合消息逐 unit 分流。

时区依次采用群 timezone、用户 Agent 配置 timezone、宿主默认 IANA 时区。可通过现有群配置/Agent 配置 API 设置 timezone，值按 Intl 校验。today/yesterday 以查询快照时刻的本地日期计算，返回包含左闭右开日期范围、时区及 asOf；按完成记录 at 过滤，不用更新时间冒充完成时间。

处理完成时间保存在现有 source unit 的可选 fixedTopicHandledAt 中；入站只有全部固定 unit 与业务 unit 结算后才完成。稳定原消息/版本/unit 身份生成同一个回复 ID，复用 outbox 和 notification 幂等、ACK、回读及重启恢复；已有冻结答复优先恢复，不重新生成。没有数据库 schema 迁移或新的 outbox/任务编排状态机，也不恢复 #288 暂停的 coordination 接纳链。

验证覆盖真实 DomainFacility 的持久化/重启、固定类别分页与失败/沉默/回复状态、mentions 契约和静默人工纠正；浏览器使用合成 React 宿主验证键盘、空态、分页、409/503 与窄屏。相关原生回归使用仓库 native profile 与确定性模型。真实 DingTalk、百部生产库上的纠正和实际模型判断由部署后的独立验证负责，不能用隔离测试代替。
