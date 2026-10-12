# 原任务控制结果的最小节点展示

2026-10-10；仅Observer展示增量，基于主线现有node.control投影。

- 当前节点status=succeeded且control.action=submit-output：会话接管完成；reuse：已复用产出；skip：不适用 · 已跳过。
- waiting且action=takeover：会话接管中 · 等待提交。没有提交结果，不显示完成。
- 运行、等待、失败、取消和需求更新阻塞保留实际status及waitReason。操作原因单独显示，不能覆盖当前失败原因。
- control.reason沿现有原因转换器显示；source=task-session/operator分别注明原任务会话/维护操作。未知或缺字段保留旧展示；不按产物存在、自然语言或旧成功推断完成方式。
- 已接纳skip单列为不适用跳过，不计入已完成步骤。其处理进度可以计为已处理，显示“步骤处理”而非“步骤完成”；计划步骤未确定仍不得显示100%。旧skipped且无control仍按旧展示和计数。
- 复用现有节点对象、stepKey、产物绑定、正文分页、会话入口和响应式样式。不新增操作面板、控制请求、服务、身份要求、数据库列或运行时逻辑。
- TaskStepElapsed、traceElapsed及任务级累计计时保持原样。耗时接口按主线固定契约继续沿用原字段；需要新增节点执行/等待计时展示时另行接入，不阻塞本次状态展示。无control仍保留旧完成标签，本补丁不推算或填假时间。

定向验证：test/observer-client.test.js（既有27项）和test/observer-node-control-display.test.js（新增7项）。本地测试不等于真实运行会话、安装或钉钉业务验收；未写现场、启动业务或部署。

依据：用户11:12授权及解除等待委派；docs/spec/task-detail-current-steps.md、task-step-duration-display.md、task-execution-duration.md。control生产与租约/授权有效性由主线负责，本UI只展示当前节点投影。

固定接口：D:/project/dsh-A-package-20261009/docs/tmp/task-session-control/CONTRACT.md（只读，快照在delivery/ui-delegation/mainline-CONTRACT.snapshot.md）。
