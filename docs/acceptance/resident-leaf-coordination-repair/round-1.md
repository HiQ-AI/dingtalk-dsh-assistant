# 第一轮：实现与反例

日期：2026-09-10。基线 `origin/main b7d0ea1`，工作分支 `worktree-resident-leaf-coordination-repair`。

## 基线

`pnpm test` 在改动前 309/309 通过（baseline-tests.txt）。当天记录显示状态事实未被协调上下文充分使用、同内容跨请求重复读取、pending 触发重复提交等问题。原始业务消息留在本地；仓库测试全部为合成数据。

## 已修复与反证

| 能力 | 最小验证 |
| --- | --- |
| 当前事实与批准来源 | task-progress 测试覆盖已完成阶段、原审批请求、原版本保留、发生时间与读取时间区分；快照不授予新操作授权 |
| 活动滚动 | Store 覆盖 501 条后仍保留新事件、序号水位、重放/乱序、写入失败重试 |
| 报告先接收 | input-wait 落盘后返回；重复 submissionId 不重做；新内容复用同 ID 拒绝 |
| 异步恢复 | 真正子进程在 settled 落文件后通知前退出；恢复 execute=0、notify=1；原生 Session/Inbox/Goal/AgentLoop 拒绝等待期新步骤且不空转 |
| 审阅接纳 | 先保存 coordination-review-accepted，再放行；相同报告重启恢复原判断；提交时间变化不换请求身份 |
| 有界重试 | 耗尽保持 failed/blocked，显式重试重置原 epoch；旧 rejected Promise 不再被当作恢复执行 |
| 计划修订 | 同值参数不清空；新证据定向失效；旧字段 generic stage 与已批准细计划可恢复且不改历史检查点 |
| Schema | Zod 为权威输入；生成 DSH 支持子集，真实 assertSupportedJsonSchema 与 validateJsonSchemaValue 验证；诊断允许阶段定位但不许推进进度 |
| 内容复用 | 可信原生 surface 校验；流程修改/禁用、压缩移出、伪造来源、跨群不误复用 |
| 短问答 | 同模型、无工具、无 Task 动作；Task 事实/关联集合/群职责/回复候选变化时拒绝旧答；纯工具心跳不进入短答事实集合 |

## 修复过程发现的缺陷

首轮 Runtime 78/91 通过（runtime-round-1.txt）；后续修复通知恢复缺口、报告恢复信号丢失、诊断被串行等待阻塞、真实 DSH Schema 子集不支持等问题。旧测试中“pending 必须报错”“普通补充必须清空”的断言随新契约改为持久接收和保留原证据，未通过放宽业务完成条件消除失败。

独立审阅又发现重试耗尽被误分成业务拒绝、submittedAt 改变请求身份、审阅回复缺持久化。均补代码与反例后重跑。群职责 CAS 的首次测试失败暴露同一逻辑请求反复进入短路径，现每次逻辑请求只尝试一次短路径，最终失败交回常驻。

## 性能证据边界

- report-latency-benchmark.json：真实 DSH JSON 存储、30 次小型合成报告；P50 3.776 ms、P95 9.119 ms、最大 10.658 ms；逐次磁盘回读及重开确认 30 条唯一报告。不含模型、Goal/Session flush、业务或群投递。
- context-replay-benchmark.json：实际加载基线协调器与当前协调器，10 轮、每轮 5 次审阅。每轮流程读取 5→1、证据页读取 5→1，正文字符 94510→18902，减少 80%。Host 校验成本没有下降，不把这说成整体墙钟减少 80%。
- model-benchmark.json：首次 30 次状态请求 21 次返回答复、9 次不完整转交。保留失败；成功样本 P50 14.667 s、P95 19.388 s。后续确认直接 LlmRuntime 不经过 agent/request-error 重试插件，短路径已按原生 policy 增加唯一有界重试链；前轮失败没有充分证据全部归因于该缺口。
- 修订后真实模型测量单独保存；所有模型样本无工具、无真实 Task/Outbox 或群发送，不能据此宣称群端 E2E 响应 SLA。

## 交付边界

PR、安装包、运行进程、配置回读单独记录于后续轮次。未重放真实生产 SQL/部署；没有向业务群发送测试消息。当前状态以 matrix.csv 为准，未全绿不生成 report.md。
