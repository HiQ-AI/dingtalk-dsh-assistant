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

## 正式安装及独立重启复核

精确包2f7072fd8dd93f5db9230f1865eb115215d30103a48fecadc16f1507f7014b51。Check writes=0，99源码匹配；完整备份owner-repair-20260929-192922-221后安装，新PID8080同时提供3080/18998。正式健康ok、inboundProcessing=true、modelMode=real、recoveryIssueCount=0；看板及详情独立headless真实浏览器0错误。

原消息source4与同话题短消息source2分别原生重处理；之前短消息无commands/effects，恢复后实际IB成功，两条result命令applied且run settled，但读取结果不触发Owner。因此通过已授权专用验收群明确记录验收事实，独立mget foundCount=1/complete=true；msg-dbec2d88d9c1b9bf0aa3fd3cb6ce5ae8de845720的S/R/IB成功、命令applied，Owner水位136并进入running。未修改需求版本或重发文件。最终Owner验收仍待读回。

独立重启核验：18368文件/773430821字节双路径SHA/inode全部通过；两个旧任务仍completed/succeeded、runSequence3/4、executionCount6/7、结果相等；群附件再次下载324字节且SHA b145ad56ad680d1193a6ed6fa7fae0e4d7352e722a1915b1f53ee8891778753e。原始session.jsonl摘要737964D0...05F358及profile摘要5d3e9c33...933f保持相同。私有证据在docs/tmp/task-unified-file-storage及task-unified-live-restart-r14，不入库凭据或二进制。

Owner lease9/10/11均提交complete但released，最终blocked、last_failure=TASK_OWNER_COMPLETION_UNVERIFIED。实际候选、原工件、文件摘要与回执经只读隔离probe逐项验证，manifest.complete=true/missing=[]；仅将语义探针固定true时结构门禁通过，用于定位而不作为正式通过证据。每轮约42秒，语义超时怀疑待独立重放确证，真实完成仍FAIL。

部署r15前置空间Check先明确拒绝：2583732224 < 2625333091字节。仅为本worktree docs/tmp中13个>1MB普通文件启用NTFS透明压缩，路径校验限定本任务临时目录且拒绝reparsepoint；每个文件压缩前后SHA相同，未删除文件、未改任务根/备份/原始会话。可用空间2648535040后重复Check通过，仍未执行r15。
