# 第三轮：可读元信息补充与初轮校验

用户追加简短标题、工作流分组、实际开始时间及卡片中文名称/耗时。实施前快照见docs/spec/task-detail-readable-metadata.md，未变更任务数据或执行逻辑。

新增定向用例覆盖标题≤32/原目标保留、不同工作流同名步骤分组和全局编号、实际startedAt/未开始/缺失时间、中文标签及卡片本次耗时。初轮失败是旧测试仍要求每步小字stageTitle和固定64px耗时列；按新分组/自适应耗时契约更新后17/17 PASS，新增行为断言未移除。

真实完成任务现有标题长300/196/302字符，当前详情时间字段63/63齐备；卡片原英文节点来源为workflowProgress以nodeId作title，原卡片耗时只查Legacy checkpoint事件，无法用于native节点。中文节点表提升为共享展示所有权，卡片复用TaskStepElapsed并匹配executionNodes，详情沿既有真实stageId分组与startedAt显示，不新建表或重新执行业务。

最终Observer静态检查0违规0警告，构建成功，diff检查通过。初轮真实React快照元信息验收通过，最终包仍需独立正式安装和页面核验，见第四轮。
