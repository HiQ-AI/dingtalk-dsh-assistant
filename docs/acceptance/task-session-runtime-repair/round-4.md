# 第四轮：人工介入、真实进度巡检与会话查看归属

## 当前状态

实现、定向验证与双包部署完成。本轮不以原任务业务完成作为插件修复通过的替代证据。

## 人工介入与巡检

- 人工申请持久绑定当前需求/控制版本、具体问题、证据与已尝试事项；真实群作者或受信Web身份答复原文入账，同任务继续。
- 等待执行结果保持执行中；等待人工为等待中，执行结果/巡检不绕过人工等待。
- 每十分钟由现有恢复tick对当前执行的真实原生日志核验，保存轻量检查点并唤醒统筹。统筹必须读取具体动作/结果/错误与目标方向，再提交决定。
- 不把无新记录等同于停止，不根据超时重放动作；每次限量摘录，完整日志保持原位置。

## 原任务本次停滞

现场原统筹sessionId=task-session-159171d8-1eef-40a6-b6f7-058eb956ee65，lease29未写入Host输入；最后Host轮为28，17:01:21结束。17:09:54出现end-seed；原生API显示Agent存在但空闲、inbox为空。原执行17:20:51提交结果。现场尚无当时页面请求日志，具体触发者未直接证实。

隔离真实SDK复现：官方follow会把冷会话恢复为普通idle Agent，后续Host原身份接续抛TASK_SESSION_ALREADY_LIVE并保留drained=false，产生同样外观。原始复现1/1通过，见test-follow-conflict-before.log。该结果证明代码机制存在，不能替代现场因果请求记录。

修复采用原有路由内Host写入归属，不改原生日志header、不热抢Agent、不改SQLite排空状态。通用读取保持可用，通用后台恢复不能抢占任务写句柄。无操作重试不能清掉未恢复故障。

## 已实跑

- test-human-ui.log：43/43。
- test-human-progress-ledger-final.log：60/60。
- test-human-http-provider.log：17/17。
- test-human-context-final.log：3/3。
- test-human-progress-native-final.log：7/7，真实原生人工与十分钟巡检（无skip）。
- test-human-effect-recovery.log的Windows换行夹具失败已修，test-human-effect-recovery-final.log定向1/1。
- test-round-4-final.log：100/100；test-host-session-writer.log 5/5、test-host-session-routing.log 6/6。
- test-deployment-round-4.log：11/11；test-package-round-4-final.log：2/2。
- 完整路由测试另有Windows文件符号链接创建EPERM，未宣称该权限场景通过；本轮关键归属/恢复定向用例无skip。

## 部署与原任务读回

Assistant包SHA256=d9b689a4ed16372b1eba8d523f37107aeb21226d8b97f8027cf4440b089e7ebf；Observer包SHA256=4f977253499057a7c6d8f78b1e1ebb143138d4747b6b6977c94b0933276f2103。源码/包/安装分别49/4文件一致；profile摘要保持21eb086e00eed66943357e14516bb1ba1b506afad2fc8c9a6d084050d1fa921b。

先Check零写入/零signal；SIGINT后独立证明PID62184及子进程退出、端口关闭、原生日志结束。ledger仍如实为drained=false且unstartedTaskClaims=[lease29]，未修改该字段；正式重启接管。部署证据见round-4/deploy/。

新PID61872、health=ok、桥健康、入站开启、恢复告警0。更重要的是原Owner同session已写lease30并完成审阅，将补验交回原executionId=431a837d-6a49-42f5-9f5f-90f559be3ba0，inputVersion=5、running。现场快照见round-4/live-task-after.json，不能以业务尚在执行声称页面需求验收完成。

生产尚无新人工申请/答复及真实十分钟到期的现场触发；相应功能声明限于真实SDK定向闭环、安装与配置，不以测试替代现场交互。
