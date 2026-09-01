# 叶子会话 Skill 执行边界调整

## 目标

撤销叶子通过 `internal.learningSignals` 把学习信号转交 Resident 的专用链路。叶子继续使用 DSH 注入的通用 Skill 清单自主选择适用 Skill；Runtime 不识别、不绑定任何具体 Skill，只提供通用的授权解释和完整执行要求。

## 现状与根因

- DSH 已在叶子首次模型请求前注入可用 Skill 的名称和描述，模型命中后再通过 `skill` 工具加载完整说明。
- 现有 Runtime 对 Goal、检查点和 `submit_task_result` 有强完成协议，但对已加载 Skill 没有通用闭环要求。
- `Task objective` 的业务动作授权上限容易与 Skill 声明的内部维护动作混淆。
- `internal.learningSignals` 又把沉淀责任交给 Resident，既削弱第一现场处理，也引入两边重复处理的可能。

## 修改

1. 删除 Task 结果中的 `internal.learningSignals` schema、工具参数、Resident 转发函数和恢复问题记录。
2. 叶子 system prompt 增加 Skill 无关的通用规则：命中并加载 Skill 后，必须完成其资格判断、必要操作、验证与回读，或依据 Skill 明确判定无需操作；不得只加载后静默返回业务主线，也不得硬凑产物。
3. 明确 `Task objective` 限制业务代码、业务数据、部署环境、外部系统和对外动作；工作区规则授权且适用 Skill 明确要求的内部维护不视为扩大业务授权，但只能在两者共同声明的内部范围执行。
4. README 改为说明通用 Skill 执行边界，不再描述专用学习信号通道。

## 验证

- Task result 严格拒绝已删除的 `internal` 字段。
- 叶子提示词包含通用 Skill 完整执行和内部维护边界，且不出现具体 Skill 名称或 `learningSignals`。
- 完成结果仍只把业务摘要、证据、交付物和部署信息交给 Resident，发信箱行为不变。
- 定向测试和全量 `node --test` 通过。
