# Round 6 — Native service 风险组与最终回归收口

日期：2026-10-29（Asia/Shanghai）

## Native task-session 风险组

- 命令：指定 `DSH_NATIVE_TEST_PROFILE` 后执行 `node --test --test-name-pattern='native completion race|native service cancellation stops|native requirement update resumes|native capacity queues promote|native session creation failure' test/task-session-service-native.test.js`。
- 完整汇总：tests 9、suites 0、pass 9、fail 0、cancelled 0、skipped 0、todo 0；duration_ms 115591.5036；exit 0。Lead 已独立读取完整输出文件并核对退出码。
- 用例逐项结果：
  - completion race drains then resumes original execution without replaying shell effect：PASS，18,691.8509 ms。
  - cancellation stops real execution process, drains session, rejects late completion：PASS，5,931.4641 ms。
  - requirement update resumes same owner with new sources and fences interrupted old result：PASS，7,706.8828 ms。
  - capacities tasks=1/executions=1、1/2、2/1、2/3 均 PASS（21,158.8335 / 18,835.0724 / 18,228.6765 / 16,036.3574 ms）。
  - native session creation failure bounded recovery retries，persistent=false/true 均 PASS（4,158.7556 / 3,670.6219 ms）。
- 此为 native service 测试路径上的本地真实进程与持久化行为，非生产部署或真实钉钉业务现场验收；容量与创建失败覆盖的是列明的配置组合，不外推到所有容量/故障组合。

## 汇总回归依据

- `task-topic-routing-native.test.js` 在并行未提交实现 diff + 指定 profile 下最终 21/21 PASS、0 FAIL/cancelled/skip，54,005.6761 ms，exit 0。先前同文件 13/13 和 19/19 运行保留在前序 round，不覆盖。含归档参数、Owner gate、材料恢复、Host 阶段和并发互斥等当前合同。
- `task-archive-scheduling.test.js`、`coordination-resources.test.js`、`performance.test.js` 在当前并行 diff 下共 50/50 PASS、0 FAIL/cancelled/skip，1,629.0329 ms，exit 0；旧基线 50/50、23,336.55 ms 独立保留于 round-1。
- `topic-runtime.test.js` 当前并行 diff 下 143/143 PASS，7,402.94 ms；Lead 四用例独立抽验 4/4 PASS，953.6322 ms。对应首轮记录见 `round-1.md`；这不是现场验证。
- 同 Topic busy / 异任务独立：见 `round-4.md`，1 PASS、6,377.8288 ms；范围为互斥和独立推进，不声称同任务请求都被串行接纳。
- Owner-wake 跨入口 hold：见 `round-3.md`，不含 300ms 采样；空槽 held execution 的独立 `--held-open-slot` 分支在 hold 期间采样 300ms，claims 不增、execution.list 增量 5，仅证明该有限窗口，不代表全局无空转。

## 历史失败与关闭边界

- 首版 Owner 门闩测试 30 秒 timeout 与测试桩调整后的通过、old-drain/cancel-failure 的两次失败及合同诊断后通过、材料 recovery 的旧断言失败及修正后通过、并行编辑 SyntaxError 事件均保留在前序 round。它们不被删除或改写成从未发生；最终矩阵反映各合同在后续修正/诊断后的当前结果。
- SyntaxError 是并行编辑期间的工具/测试启动事件，不是独立产品行为合同，不作为验收用例；原始 stderr 未留存，不推导产品故障。
- 不重放真实 #408/#409，不操作生产库，不做生产部署；真实线上耗时归因、真实 DWS 通知和真实 Agent 生命周期不在本轮范围。matrix 将这些标为 `OUT_OF_SCOPE`，不以 PASS 表示。
- 已明确验证当前 Store 构造的旧键序指纹记录：真实写入反转键序 action/topicRefs 后重启，旧 hash 保留、同值成功、异值拒绝且版本/Owner 不增。未验证旧版本完整数据库迁移、突然 crash recovery 或未列出的容量/故障组合，不将这些未验边界标 PASS。
