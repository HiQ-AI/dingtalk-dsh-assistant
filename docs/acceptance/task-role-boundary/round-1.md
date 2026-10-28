# 首轮验证

真实 DSH registry、filesystem、Session 和 SQLite；模型输出为确定性夹具。环境变量 DSH_NATIVE_TEST_PROFILE 指向当前本地原生宿主 profile。不是线上模型速度或真实钉钉交付验收。

- skills-native：7/7 PASS。验证统筹继承目录收紧、实际 Shell/写入/晚注册/同名替换拒绝，正常技能和证据读取、技能更新恢复保留。
- service 定向：单执行文件复制闭环通过；并发旧夹具把统筹后续读证据计为第 4—6 次读取，却等待计数等于 3，导致 FAIL。诊断日志保留，业务断言与超时未放宽。
- stale-context 修前反例 FAIL：补充使旧绑定失效后误写技术阻塞，出现 DYNAMIC_TASK_REVISION_STALE，未自动接续。
- human/progress/follow-conflict/model/package 五文件：26 PASS、1 FAIL、1 cancelled。人审 write 已正确拒绝，但旧断言仍要求原人审错误码；打包用例在 npm pack 阶段触发原 30 秒超时，仅观测至 staged，不把原因猜成模型耗时。
- 六场景独立评估发现详细程序的同条/拆发措辞冲突。保持首次发现，进行窄修。

所有首轮原日志在 round-1/；技能评估保留首次问题及后续复验节。
