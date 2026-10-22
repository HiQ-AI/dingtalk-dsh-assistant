# R19 独立最终复审：DSH 按需执行团队

## 结论

当前修改未发现阻断交付的问题。生产差异仅移除团队累计人数上下限及相应提示；团队按实际必要性拆分，原有并发容量、资源互斥、身份/版本、未排空和未知效果完成保护仍在。本审查只读源码、冻结摘要与实际日志，没有调用模型、运行新子进程测试、操作现场配置或账本。

基线为 `12f13e0379f34745ba215f441d27af80291b2bcf`（上游 PR #249）。当前三份生产源码及 Store 测试 SHA256 已独立计算，与 R18 `implementation-results.json` 全部相符；Store 日志 SHA 也相符。

## 实现检查

- `dynamic-task-store.js` 只删除新 dispatch 时累计 10 名的拒绝语句；原稳定 key 去重、内容冲突、租约/输入版本、续办和资源合同未改。team/list 没有额外 10 名截断。
- `task-session-service.js` 删除 min3 函数引用及 complete 前人数查询，成员 prompt 不再声明 3–10 人；完成仍通过原 `task.complete`，调度 `executionLimit`、task slot 和后端创建时固定逻辑未改。
- `task-session.js` 删除 min3 函数，Owner 指引与提交 description 支持直接处理、单成员和多成员；就绪并行、共享写入、原身份续办、必要独立核验、逐轮文档和授权边界保留。
- 上游 #249 对能力/配置问答的范围收敛段落保留。此段仅从“生命周期、团队及未知效果完成条件”删除已撤回的团队人数条件，没有删除必要证据、结论因果、限定对象或不追加无关现场调查规则。
- README 与当前运维说明一致，并明确累计人数不等于同时运行容量。跨轮 `evaluate-model.mjs` 已去掉旧函数导入和人数断言，更新为 adaptive-team；其零模型自检通过，不把该自检写成新模型行为验收。旧 round 原证据未修改。

非阻断文字残留：未改动的 HTTP 分页测试仍有 “current ten-member cap” 及历史 10+43 夹具注释；实际只是创建 10 条、再保留 53 条历史分页覆盖，没有生产限额判断。此次没有为更新注释变更已审历史夹具，也没有删除分页断言。

## 测试证据及边界

| 证据 | 独立读到的结果 | 能证明的范围 |
| --- | --- | --- |
| R18 `store-adaptive-1.log` | 123 PASS，0 fail/cancel/skip，9373.558 ms | 12 个 Store 身份真实登记/claim/result/drain、原身份续办重开；资源及 unknown 等原合同。结果由测试提交，不是真模型工作。 |
| R18 `native-resources-model.log` | 8 PASS，0 fail/cancel/skip | 原生资源读取、同 Task 定向通信、终态不重启及 Owner 模型与执行选择隔离。 |
| R18 `model-harness-check.log` | adaptive-team，PASS，modelCalls=0 | 当前跨轮脚本可加载、场景与路径合同自检；未运行模型。 |
| R19 `native-adaptive-2.log` | 7 PASS，0 fail/cancel/skip | 零/单/双/十一成员、原身份恢复、两轮文档冻结、未排空/unknown 保护。该次十一成员预算曾为 90 秒，不能当作原 45 秒配置验证。 |
| R19 `native-eleven-3.log`、`native-source-freeze-3.json` | 当前原 45000 ms 配置复跑 1 PASS，0 fail/cancel/skip；日志用例 48507.9863 ms，总计 49267.2713 ms | 11 个独立 DSH Session 的真实文件 write/read、最多 2 个执行占位、结果/文档与完成。报告保留日志实际总时长，不声称墙钟 ≤45 秒。 |
| R18 `release-smoke-1.log` | 12 PASS、2 timeout cancelled | 首错原样保留，不能称该次全绿。 |
| R19 `package-fixed-artifact-1.log` | 固定包入口复验 2 PASS，0 fail/cancel/skip，28787.318 ms | 已有包验证入口、原测试与原 30 秒预算下抽取包执行及启动健康通过；不替代本机安装和真实业务验收。 |

两个新反例有实际可证伪对象：未排空例核对拒绝返回的原 execution/task 身份及 `drained=false`，同一个成员排空后才完成；unknown 例在注册的原生工具中真实写文件后模拟回执丢失，核对同一 operation 持久 `unknown`、唯一工具调用、任务仍 active 且没有完成事件。未以 shell 非零退出或模型自述替代未知效果证据。

原生用例采用真实 DSH Host、持久化、文件工具和可控模型适配器，证明 Host 合同和文件结果；不声称已验证真实模型的自适应拆分质量。现场仅沿用 R18 `runtime-readback.json` 的读取时点：有效 DSH、并发 8、健康正常；本轮审查没有据此宣称新代码已部署。

## 保留首错

R18 `native-adaptive-red-1.log` 和包测试 timeout 保留；R19 修正的是测试错误结构假设、使用既有固定包入口，并把十一成员用例预算恢复原值后另存复跑。未覆盖旧失败、未放宽生产保护、未把旧 Claude/Teams 轮次改成当前交付证据。
