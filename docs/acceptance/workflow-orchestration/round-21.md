# 第21轮：三条已重开任务缺失原 Session

## 现场

翻译、合并提醒、单位不一致任务分别处于 queued/inputVersion2/runSequence2、10、7。三条均已由真实 Topic 决策重开，但原8月的childSessionId在当前会话目录及备份会话文件中缺失，Runtime每次尝试resume均报该ID not found。Task记录保留当前目标、Topic版本、历史执行结果及旧Session身份。

## 修复与回归

仅queued、reopenContext、已有runHistory且resume明确报当前ID不存在时，创建独立新Session并先持久化新ID和恢复事件，再走原TASK_REOPEN及Topic输入路径。旧ID保留在runHistory；向新叶子明确提示旧会话细节不可恢复，须独立核验。其它读错、别的ID缺失、非重开running均保留原身份并继续报错。

- 针对测试2/2，含重启幂等、单Task不重复、原版本不变、非缺失故障不切换。
- `node --test`：632/632 PASS，0 fail/cancel/skip，122.67秒；完整输出round-21/full-tests.txt。
- `node scripts/build-web-client.mjs`无生成文件变化；`git diff --check`通过。

## 待现场核验

完成精确包安装、逐项旧/新Session、Task状态、来源版本、桥接与延时存活回读后补充。历史轮次不能依赖缺失会话自动重建为已验证结果。
