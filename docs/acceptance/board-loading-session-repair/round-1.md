# 第一轮实跑

原生会话/协调器/通知/前端联合101通过；详情6通过、收信箱相关16通过、轻量大节点投影1通过。补充详情共享请求及切换旧响应后前端24通过。UI strict audit错误0警告0。

runbook零写Check、完整备份、精确包安装、启动及Resume通过；PID46796，dispatchResumed=true，Task数1，配置零写且摘要不变。Assistant828d80fb6e63a5429c248f6023ced4e47c8c5f2bdaf4eb1b907bcebde9f4a4fc，Observercd0677cd5e7ca94202350efde638d7a6945a2b731076708f6efc785a0a6bb014。

现场/state/groups 4900/13567/11509ms；详情3746/4549/3586ms，尚未达到稳定快速加载。浏览器首次看板4603ms，后续15855ms，因此不宣称已完成。发现95条通知仍逐条读取补发记录，继续改为每页批量读取，进入第二轮。

原生session/list已实际返回两个当前协调会话cwd=D:/baibu-agent、完整群名及danger-full-access；第一次点击被独立Codex Connect更新浮层挡住，下一轮先用“稍后提醒”关闭浮层并真实打开验证。

重复第二条开始通知msgT6wEC2YDwHF7cX9Zf41fPA==：DWS精确读取确认来源及正文后撤回SUCCESS；独立完整时间段2026-10-01 23:33–23:35查询complete=true/count=0。原始开始通知msgWV8D6UBkeEsqZkmupsKGBw==精确回读foundCount=1，正文保留。没有改写原消息或发送新通知。真实通知账仍保留已送达审计，外部撤回证据另存；没有伪造群内授权源写入受管操作。
