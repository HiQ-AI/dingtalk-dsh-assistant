# 第七轮：真实消息单元话题绑定

最终统一以创建命令unitId/sourceKey查message.topic.bindings，逐群复用本次只读查询；只接受同群真实绑定。引用返回groupId/topicId/当前revision/title。关联卡片从可读取原群任务继承绑定；无绑定为空，不根据任务标题猜测。前端按引用的群ID查询标题、点击/键盘打开，话题详情的关联任务也按该群ID匹配。

最终服务135/135、Observer19/19，0 skipped；多次重执行继承、不可读取原群不暴露引用、按钮和键盘导航通过。构建和diff检查通过。正式API10张workflow卡片中9张有真实话题、两张Web卡片均恢复；其余一项无真实绑定不填充。

受控Check零写、维护封存、完整备份、精确双包安装和独立Readback通过，PID35256，认证页面200、派发恢复、recoveryIssueCount=0。本轮不改业务记录。正式Edge独立上下文检查两张Web和一张普通任务，1440鼠标点击及390键盘打开均到正确话题详情，并能反查对应任务；无横向溢出，页面错误/业务写入0。浏览器第一次因迟到版本提醒遮挡失败，补齐按稍后提醒关闭后完整重跑通过。匿名证据topic-label-summary.json。

运行边界：本轮控制健康degraded，inboundProcessing=false，DWS监听退出5和读取失败1；独立读取C盘Free=0，尚未确认两者因果。卡片与话题GET功能通过不代表钉钉收信正常。本轮未清理磁盘、未修复外部DWS环境或发送消息。安全摘要topic-runtime-summary.json；原始控制账诊断、启动日志仅docs/tmp不提交。

PR交付状态由独立gh回读确认；未合并或发布。
