# 第21轮：三条已重开任务缺失原 Session

## 现场

翻译、合并提醒、单位不一致任务分别处于 queued/inputVersion2/runSequence2、10、7。三条均已由真实 Topic 决策重开，但原8月的childSessionId在当前会话目录及备份会话文件中缺失，Runtime每次尝试resume均报该ID not found。Task记录保留当前目标、Topic版本、历史执行结果及旧Session身份。

## 修复与回归

仅queued、reopenContext、已有runHistory且resume明确报当前ID不存在时，创建独立新Session并先持久化新ID和恢复事件，再走原TASK_REOPEN及Topic输入路径。旧ID保留在runHistory；向新叶子明确提示旧会话细节不可恢复，须独立核验。其它读错、别的ID缺失、非重开running均保留原身份并继续报错。

- 针对测试2/2，含重启幂等、单Task不重复、原版本不变、非缺失故障不切换。
- `node --test`：632/632 PASS，0 fail/cancel/skip，122.67秒；完整输出round-21/full-tests.txt。
- `node scripts/build-web-client.mjs`无生成文件变化；`git diff --check`通过。

## 本地部署与现场回读

- 部署前`--check -AllowActiveTasks`通过，v9数据0 invalid/stripped/unknown；按用户此前批准的中断重启授权停止已核验DSH进程树。停机后备份存储与profile至`D:/dsh_home/backups/decision-context-ff6f29f-20260922`，备份hash一致。
- 部署源码ff6f29f，包SHA256 `F2D1A662776358BD8A9A331553AF148264A80AAF0CEF39CF34937BAE26BEF88C`；安装34个JS文件与源码hash逐一相同。新PID199008，3080/18998同进程，Web认证303→页面200 HTML，stderr空。
- 三条目标Task均保留原Task ID、inputVersion2、runSequence2/10/7、Topic引用与runHistory；各有且仅有1条`task-reopen-session-recreated`，新Session文件存在且分别收到TASK_REOPEN和TASK_TOPIC_CONTEXT。三条当前均running，旧已接纳业务操作数量各自保持1未重复。
- 健康ok、恢复告警0、DWS桥接与入站处理正常；独立结构化回读见round-21/runtime-readback.json、web-readback.json。
- 历史轮次的原Session细节仍不存在；三条当前仅确认已恢复执行，业务目标完成和真实渠道结果需由各Task后续提交并审阅，不能预先判定完成。
