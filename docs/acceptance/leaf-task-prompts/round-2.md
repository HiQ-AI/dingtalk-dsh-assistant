# Round 2：按目标组合加载

本轮基线为 `main@d4027aa`，分支为 `feature/task-prompt-composition`。流程按需加载即加入当前集合，取消固定五条上限；可选集合调整只用于修改保留项。未修改 UI、用户配置或具体业务工作流。

## 证据

- `node --test test/runtime.test.js`：67/67 通过。
- `node --test`：257/257 通过，0 fail、0 skipped。
- 长任务组合测试：7 条配置中按需加载 6 条，再重复读取第一条，Task 引用仍只有 6 条；未调用必需选择步骤即可注入。保留 6 项时不再触发数量上限。
- 同一测试将 Session 历史设为空后重建 Runtime，6 条已加载正文均存在、未加载第 7 条不存在；缩减保留集合后旧正文消失，随后加载第 7 条正常加入。
- 目标变化的回归测试：inputVersion 更新后旧组合清空；队列中迟到的加载和集合调整都抛出 stale，不能污染新输入。
- `load_task_prompt` 返回值精确符合声明字段，避免将 enabled 等配置字段带入 additionalProperties=false 的工具输出。
- `git diff --check` 通过。

## 边界

上述测试在真实 Store 与 Runtime、可控 Session fixture 中证明流程持久化、组合和重建，不冒称触发了真实模型的压缩或证明任意任务语义匹配正确。具体匹配由叶子判断，不增加固定任务类型映射或后台分类器。
