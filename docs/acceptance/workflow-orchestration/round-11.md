# 第 11 轮：全仓本地回归

```powershell
node --test --test-timeout=30000 --test-reporter=spec
```

596/596 通过，0 fail、0 cancelled、0 skipped，耗时 86.60 秒；原始输出见 round-11-full-tests.txt。单项 30 秒上限容纳实际 Git worktree 归档，不放宽业务门禁或断言。

覆盖：结构化计划/证据、工具 schema、报告接收/恢复、原生 AgentLoop 许可、Runtime 取消与重启、未知动作对账、部分成功 Decision 恢复、真实 JSON backend 迁移、材料分页、检查器、HTTP 与看板/任务表投影、既有 DWS 替身发送回读。

新增反证均纳入完整回归：上游否定传播到下游；跨 input/plan 必须有连续保留链；未引用模型证据不能夹带通过；已成功 operation 不能解锁另一未知 operation；通知写入双重故障不产生未处理拒绝；历史完成没有意图不补发；无许可 Goal 耗尽不自动扩轮。

构建 `node scripts/build-web-client.mjs` 完成后，对 assistant/web-client.js 的 `git diff --exit-code` 为 0。三个 workspace 包 `pnpm pack` 成功，独立 tar 清单确认 task-plan/actions/checks/permits 与 storage-v8-schema 在 assistant 包中。包未发布、未安装，正式版本号保持 0.5.15。

此轮证明本地契约及隔离恢复，不证明真实渠道、生产数据迁移、模型语义判断质量或外部业务 exactly-once。E01 根据用户“先完成本地验证与 PR”指令不执行。
