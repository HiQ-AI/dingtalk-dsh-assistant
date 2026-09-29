# Round 14：动作必填字段提示与校验同源

## 正式失败事实

主代理正式观测：r13 包已安装，PID 27592，99 个文件验证通过。原生 reprocess 的新消息 `msg-replay-eed496771bf267bc165a4f4412ef40d585aef2e1` 已实际调用 IB，未再触发输入容量超限。两个 decision 均选择 report，但 arguments 缺 language，Host 拒绝：`MESSAGE_SCHEMA_INVALID` / `report requires language`；随后重试因累计预算不足返回 `MESSAGE_BUDGET_EXHAUSTED:IB`。没有业务 commands 或 effects，Owner 仍 blocked。保留失败事实，不把前轮容量修复等同业务完成。

## 确定合同缺口与最小修复

`taskActionSchema.superRefine` 的按动作必填字段未出现在 Zod 导出的 JSON Schema 中。将既有列表抽为 `taskActionRequirements`：校验先复制列表，再追加工程 repositoryId；I/IB 系统提示从同一 map 自动生成必填规则。没有放宽 schema、补默认参数、提高预算或更改正式账。

## 本地实测

- 先红：`report-language-fail.log`，旧提示不包含 report.language 条件，新增断言真实失败。
- 后绿：`node --test test/message-workflow.test.js test/message-ledger.test.js`，130/130 PASS，0 FAIL/SKIP，13744.8007 ms；`report-language-regression.log`。
- 缺 language 仍拒绝，合法 zh-CN 通过；工程缺 repositoryId 拒绝、齐全通过；随后普通 create 通过，共享 map 没有被工程附加条件污染。
- `verify-ib-lossless.mjs`：sourceUnchanged / exactRestoration 均 true；完整新 system + 重建正式输入 31552 / 32000 B，余 448 B。
- `git diff --check` 通过。源码仅两个现有文件 +6/-3 行，现有消息测试 +20/-1。

上述日志及只读重建证据在 `docs/tmp/task-unified-file-storage/`。未提交、未部署、未对外发送、未修改正式 DB；真实消息续跑及 Owner 完成结果待主代理独立验收。
