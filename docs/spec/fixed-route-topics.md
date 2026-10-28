# 固定话题路由类别

Task-session 的 Route 保留普通业务 Topic，同时提供两个稳定类别：职责外话题（out-of-scope）和职责内Agent平台相关（agent-platform）。类别通过 source unit 的 fixedTopic 字段保存，不是可新建、合并、关闭或续办的业务 Topic。分类仍由现有 Route 根据本群职责和原文语义完成，没有新增分类模型或关键词名单。

职责外 unit 不进入 Topic Decision 或 Task Owner。真实 mention 元数据证明被 @ 时，通过原通知链准备“这个不是我负责哦”；否则直接结算该 unit。事件缺少元数据时，生产适配器按本群、原消息时间窗口调用 DWS chat message list-mentions，逐页核对原消息身份。读取失败保持未处理并报告错误，不能凭文本里的 @ 名称推断原生提及。

平台整体问询使用独立原生 session。只暴露 platform_task_query 与 platform_reply_submit，没有文件、shell、创建、唤醒、取消、完成等权限。工具读取本群真实任务（包括同库归档），按状态和本地完成日期查询；列表分页返回 nextCall，提交前检查已发起查询的所有页读完。平台会话只准备答复，不创建业务 Task；修改管理请求只能说明只读能力边界。具体业务进展如“UPR导入修好了吗”仍归业务 Topic；混合消息逐 unit 分流。

时区依次采用群 timezone、用户 Agent 配置 timezone、宿主默认 IANA 时区。可通过现有群配置/Agent 配置 API 设置 timezone，值按 Intl 校验。today/yesterday 以查询快照时刻的本地日期计算，返回包含左闭右开日期范围、时区及 asOf；按完成记录 at 过滤，不用更新时间冒充完成时间。

处理完成时间保存在现有 source unit 的可选 fixedTopicHandledAt 中；入站只有全部固定 unit 与业务 unit 结算后才完成。稳定原消息/版本/unit 身份生成同一个回复 ID，复用 outbox 和 notification 幂等、ACK、回读及重启恢复；已有冻结答复优先恢复，不重新生成。没有数据库 schema 迁移或新的 outbox/任务编排状态机，也不恢复 #288 暂停的 coordination 接纳链。

验证为隔离合成 fixture 与现有核心回归。固定类别专属 16 项、Route 混合分流用例通过；组合回归及最终 PR 证据见 docs/acceptance/notification-readback-split/。未调用真实 DingTalk、未恢复真实任务库、未部署。原生 resident profile 未安装的用例明确跳过，不视为通过。
