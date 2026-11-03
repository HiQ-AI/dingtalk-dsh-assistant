# 第 6 轮：失败修复与剩余覆盖复验

日期：2026-11-03

## 当前结论

本轮完整结束，原生补验48项38通过、10失败，drift=[]，不宣称全绿。保留第5轮已见的4例超时及整批被外层采集deadline截断的事实，本报告不覆盖旧结果。核心源码仍与第5轮215文件绑定一致；本轮只修两个原生测试夹具，未改产品调度。

## 四例原生失败的处置

- batch-followup：旧测试在route阶段断言decision专用提示，导致未提交路由。现route断言当前目录核对提示，原批量事项提示保留于decision阶段，业务断言和原30秒阈值不变。成员原命令 `node --test --test-name-pattern="native batch followup reopens" test/task-topic-routing-native.test.js`（同次设置隔离 `DSH_NATIVE_TEST_PROFILE`）→ 1 pass、0 fail/skip、exit0，business1823ms。Lead独立全文回读并归档 `round-6/batch-followup.log`；SHA256 `dbded56432d8b4ab8cb3e91d0b5c8d388490c438cbc1280683b8581f3d1db6a1`。该次未采产品全量前后hash，不追补伪造当时绑定。
- 三个“话题历史”用例：版本推进后旧rev2提交stale是正常屏障；旧脚本继续重提旧版本且按requestId复用审阅，阻碍后续轮。时序证明停止旧版本后rev3可在业务期接续。通用夹具按requestId+revision停止旧轮并重读新版审阅，原15秒3/3、business1450/1509/5443ms，前后测试/runtime/coordination hash一致，Lead已独立核对原输出。然而该版本删除了基线原有 `h.requests.length<12` 断言，故该次只记中间验证。原断言恢复后，Lead本轮同阈值复验3/3、0skip/取消、exit0，证据source-history.tap及native-binding.json。
- 中间实验曾使用全局停止条件误停新revision，所得0/3不能用于证明产品调度阻断；取消清理期的末尾快照也不证明业务期是否送达。不把这些已被反证的推断作为最终根因。

## 最终执行结果

C最新context-02定向1/1通过；最终串行离线执行development104/104、holdout16/16，failures=[]，cleanups分别104/104及16/16全部absent，streams=0、summary=null、所有结果modelQuality=not-measured。Lead独立读取本轮三个evaluation JSON：before==after且当前逐源码SHA一致，数据SHA d41bbddbd23979017766a18f1b111e722bbb4109ba40a2eab8983a5669e93cfc；context-02观测messageVersion1、epoch0→1、observedUnrelatedHold=true、最终routed。这证明runner/fixture/真实Host合同可执行，不证明120场景语义金标正确或真实模型通过。

Lead接回原生资源后完成串行补验bmlogz5cx，各用例保留原阈值，无任意外层600秒截断。238个源码/测试/profile/锁文件前后哈希无漂移。首次采集脚本因Python反斜杠转义SyntaxError在编译期退出，未启动测试，改用Path.as_posix后执行。

| 批次 | 实际结果 | 证据 |
| --- | --- | --- |
| 恢复原guard后的话题历史 | 3/3通过，exit0、无skip/取消 | source-history.tap |
| task-topic截断后剩余路径 | 25项18通过、7失败，exit1 | topic-remaining.tap |
| web/澄清/hold | 17项14通过、3失败，exit1；澄清12与hold1均通过 | web-clarification-hold.tap |
| 原先skip的notification原生3例 | 3/3通过，exit0、无skip/取消 | notification-native.tap |

新见10个失败：task-topic的多收件人quoted两变体、Topic归属/任务/忽略/恢复幂等、显式requester handoff、业务通知423–424、聚合交付、仅指定通知接收人需求；web的未提交输入保留两变体及含图片富化源版本复用。其中web前两例业务20秒超时后cleanup20秒也未结束，保留AggregateError与deadline事实，不把已调度当终态。Lead独立读取上述完整TAP摘要与失败栈，核对每日志SHA及绑定，定向Win32_Process未发现匹配本批次文件的遗留node，无kill。

B重新独占task-topic-routing-native与task-web-topic-reuse-native两测试文件及原生运行资源，先取真实工具拒绝/脚本错误，再定点修复并用原阈值复验10失败。若涉及产品由A唯一写入；其余已绿未变部分不重跑。后续修复复验新增第7轮，本轮失败与原始输出不覆盖。


本轮仍未运行真实模型、真实钉钉、真实角色内大候选/metadata续读E2E、CI或部署。真实模型持续旧版本提交的调度风险未由脚本夹具测试排除。既有固定摘要合同失败仍保留，精确基线证据见round-2。

## 附件保留说明

本轮报告中的原始中间附件已按保留规则清理，不另行备份或转移归档；原轮次结果及失败不变。最终必要证据集中保留于 `round-7/final-validation.json`：含各批命令、执行时/当前源码SHA、嵌套测试记录与失败细节、原日志SHA、全部104/16评估观测和前后绑定。第7轮两份最终原生TAP仍保留。汇总已独立核对后才清理原附件，不能将新汇总当作重新执行测试。
