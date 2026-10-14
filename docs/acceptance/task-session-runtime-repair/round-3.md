# 第三轮：上下文、模型过载与执行中归类

## 根因与反证

现场模型可见surface消息正文605176字节，17条消息中4份Host输入快照分别118132、90704、172541、126788字节。当前执行记录还递归包含input.previousExecutions，重复引入旧输入、运行定义及历史结果。群职责和preset并非这次膨胀的主要来源，保留必需指引。

原生日志当前lease turn/end精确记录PI_AI_ERROR及上游overloaded（HTTP200仍包含模型失败）；旧统筹返回no_submission丢失provider错误，service转blocked并消费wake。不能从该过载回执断定上下文造成服务器过载。

看板将统筹drained直接映射waiting，未读取受控执行状态；Observer按DTO分桶本身没有错误。

## 实现

执行上下文使用明确字段投影，保留身份、版本、当前目标/状态/结果，自动列表和task_execution_read均不传完整旧输入、定义、结果历史；新委派previousExecutions不再递归。操作快照省略宿主绑定及重复成功回执。原始持久账不变。

每次原任务续办前，以原生surface replace把旧Host快照替换为短历史标记，只保留本轮完整快照；原始审计日志不删除。当前来源/约束、群职责和原生preset保留。不会宣称清除了模型已有compaction摘要或全部工具历史。

临时provider错误精确识别后抛至已有退避调度，保留原wake，不写业务blocked。旧版已误blocked任务只在当前lease末尾原生错误证明过载/暂态网络、无业务question且已排空时补持久唤醒，普通配置错误不恢复。提交后尾随错误不能覆盖成功决定，未知效果不重放。

统筹wait且有排队、running或未排空执行时DTO仍running；真实问题、业务blocked、暂停及终态各自保留。

## 定向验证

- 三代原生委派、只保留一份当前Host快照、授权来源仍可见、原日志保留；实测最终新增输入16525字节，完整测试模型请求41086字节。它是测试夹具数据，不当作现场总token节省。
- 原生看板列表及详情在统筹wait排空而小目标仍运行时显示running。上述2/2通过：test-context-round-4.log。
- service/投影/看板组合35项中34通过、1项旧断言把surface替换审计事件算作新增输入失败；已改为明确排除历史投影事件，原断言仍要求恰好2次真实输入；独立重跑1/1通过：test-native-source-final.log。
- provider/效果围栏/技能14/14通过，无skip：test-provider-fence-final.log。覆盖一次过载后同会话续办、旧blocked精确恢复、普通错误不自动恢复、已提交优先和unknown不重放。
- 最终真实npm包解压运行2/2通过：test-package-context-final.log。

## 部署

最终包SHA256：6d2808c6b3263c58b25eea165e257cd9604c2bb3db85447d899aaa7b6a21f647。Check确认零写入/零信号、旧任务及执行已排空、unknown操作和通知均0。沿既有原生SIGINT停机安装路径更新Assistant；最终显式安装当前Observer原包，profile不变。

单独安装Assistant触发既有override将Observer解析回旧包，保护检查阻止启动；读取发现实际内容变化后，显式双包安装并独立核验49/4文件一致，再启动。脚本已要求两包及摘要作为必填参数，runbook同步，避免再次误回退。

新PID62184、health=ok、恢复告警0、入站/桥接正常、自启开启，profile摘要保持不变。原任务同一统筹session从lease20的误blocked恢复至lease21，已再次委派原执行；API state=running、waitingReason为空。业务最终交付仍进行中。

现场模型可见surface消息正文605176→127576字节，约减少79%；原4份巨大Host快照仅保留短历史标记，当前完整输入24016字节（旧末轮126788字节）。这不等于总token数，仍保留必要system、compaction摘要与工具历史。摘要见context-baseline-summary.json、context-after-summary.json及deployment-context-summary.json。部署只读证明测试1/1通过。
