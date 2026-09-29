# 第五轮：Web 重执行群名

根因：本次Web执行的conversationId投影为groupId，卡片查群表失败后显示技术标识；既有关联链存在，但汇总没有携带可读取原任务的群来源。

修复：workflow-service的groupTaskExecutions仅从已通过权限筛选的关联任务取得非Web sourceGroupId；执行groupId、通知与授权保持原样。Observer用sourceGroupId解析显示群名，悬浮注明Web重新执行；缺少可读取群来源显示Web任务。不改存量业务记录。

最终验证：服务135/135、Observer18/18、0 skipped，多次重执行和不可读取原群的权限反例通过。首次服务测试因C盘临时目录ENOSPC失败，改为本仓docs/tmp专用临时目录后通过；无业务数据清理。浏览器脚本首轮菜单名错误、第二轮版本提醒遮挡，按既有菜单和稍后提醒操作修正后通过，没有修改产品去绕过。

受控Check writes=0；维护封存、备份、精确双包安装和独立Readback通过，新PID38412，ready=true、dispatchResumed=true。正式只读API与新Edge上下文核验用户指出的Web来源两张卡片：sourceGroupId对应真实有名称群聊、groupId保持Web；1440/390页面显示群名不显示Web标识，页面错误/业务写入0。匿名汇总group-label-summary.json；敏感启动日志、群名、截图与原始数据仅docs/tmp不提交。

未重跑真实业务、未发送消息、未合并或发布。PR状态由独立gh回读核对。
