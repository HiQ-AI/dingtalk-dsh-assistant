# 第2轮：真实模型策略与进度事实

使用当前统筹配置 `gpt-6-astra / low`、已安装web原生profile与Connect，生产 `createTaskSessions` 和 `openDynamicTaskStore`。委派/续办/反馈经真实SQLite账本，但不启动执行器、不发送消息。唯一可编辑文件为 single-simple 自己的合成fixture；其余只允许本轮model-content读取及隔离回调。每例120秒上限，原始请求/流/调用与源码快照留 `docs/tmp/task-collaboration-model-round-2/`。

统筹源SHA256：`d4941c7d885e0f8bb2b584cc7290e253e1ed5ca6e3c2ac3b231aafff025c3a53`。见 [model-results.json](round-2/model-results.json)，结构断言7/7通过；其 `semanticReview=PENDING` 是自动输出，人工结论以本记录及matrix为准。

| 场景 | 人工语义结论 | 实际观察 |
| --- | --- | --- |
| independent-ready | 待复验，进度措辞有歧义 | 两个不同目标首次wait前登记，context、范围、资源键和交付证据明确；“并行推进”未明确待启动 |
| single-simple | PASS | 统筹read→edit→read→complete，未另派；独立回查仅instlal→install变化 |
| dependency-pending | PASS | 读取原进度后等待单位结论，不猜公式或新派依赖工作 |
| dependency-ready | PASS | 读取两条原样本及结果，用original-execution和新key续办，未重做调查 |
| shared-writer | PASS | 单执行独占同一文件两字段修改，要求分别验证和最终读回 |
| complex-self-claim | FAIL：进度事实 | 固定版本、只读三类验收及反例均合格，但seq36仅queued，seq41却称“正在独立核验” |
| simple-proven | PASS | 两份原始version快照一致，直接完成，未机械增加执行 |

主会话与独立审阅者分别检查objective/context、回执、决定及原生sequence，没有把工具计数当语义结论。本轮不能宣称全部模型语义通过。

修正统筹指引：queued/available只报告已登记/已安排、待启动或待结果；running也不能代替具体活动证据。下一轮只复验受影响的两例。

边界：有限合成输入下的选择不代表真实业务执行、长期改善比例或所有任务都能正确拆分。共享写入/高风险场景仅提供委派出口，不能断言所有情况下都应委派。
