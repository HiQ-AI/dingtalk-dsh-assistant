# Round 12：隔离原生 DSH 工作流验收

日期：2026-09-22。最终执行退出码 0，原生 DSH 版本 0.1.2-rc.1。覆盖当前工作树，不代表发布、安装切换或真实钉钉投递。

## 命令与隔离

```powershell
node docs/acceptance/topic-driven-processing/scripts/verify-topic-dsh.mjs D:/dsh_home/profiles/web/node_modules/@deepseek-ai/dsh
node --test --test-reporter=spec test/fake-llm.test.js
```

第一条参数仅使用机器上现有 DSH 程序目录。脚本新建独立 DSH_HOME、topic-e2e profile、JSON backend、Session 目录和临时 loopback 端口。真实模型关闭，fakeModel=true，DWS disabled，writesAuthorized=false。没有读写 web profile 配置或启动真实 DWS。

生成目录：`docs/tmp/topic-dsh/2026-09-22T07-22-17-893Z/`。临时 profile、会话和存储不入 Git；脚本可以重新生成。

## 实测结果

- 健康回读：transport=fake-dws，inboundConfigured=false，inboundProcessing=false，outboundAuthorized=false，modelMode=fake，recoveryIssueCount=0。
- 两个独立群事项各完成归类与决策；一个 Web Task 完成计划、两个阶段、最终审阅和通知入 Outbox。共 3 个 Topic、3 条 Outbox，三个 Decision 均 completed。
- 原生会话日志统计：task_plan_prepare=1、task_artifact_register=1、submit_task_checkpoint=3、submit_task_result=1、group_topic_route_submit=2、group_task_review_submit=2、group_decision_submit=2。
- 独立读取磁盘 JSON：domain version=9；唯一 Task contractVersion=2、state=completed、outcome=succeeded、plan.revision=1，result 有 1 条 criterionReview。
- checkpoint 顺序为 plan-confirmed / stage-completed / stage-completed；remainingItems 为 2 / 1 / 0，全部 acknowledge。重复 Web request 后 Task 数仍为 1。
- 子进程正常退出；独立进程枚举未发现 `--profile topic-e2e` 的残留 Node 进程。生成 evidence.json 为 1816 bytes，dsh.log 为 0 bytes。
- fake adapter 单元验证：8/8 PASS。新测试真实调用同源 prepareTaskPlan / validateStageOutput / validateCriterionReview；received+pending 时停止，approved+applied 才继续，rejected 拒绝推进。原生流程也实际调用了准备与登记工具，没有由模型伪造 Host ID。

## 排障记录与改动

1. PATH 上 dsh.ps1 指向已不存在的旧安装路径，首轮 MODULE_NOT_FOUND。改用已核实存在的程序目录，未修改全局安装。
2. 老验收脚本重复插入 dsh-base 已有 storage 插件导致 duplicate id；改为配置现有 storage-json/root 和 storage-domain/backend。
3. 标准 preset 需要 Host `subagent-model-selection-settings`；隔离脚本显式安装该 Host 设置并保持 enabled=false。修订后整条原生流程通过。
4. fake adapter 从当前系统计划来源生成 draft，调用 Host 分配 ID，登记 fake:// 协议产物；不再使用旧字符串 checkpoint 协议。收到 TASK_REPORT_REVIEWED 时回看对应原输入与 submissionId，不把收件当批准。

## 边界

fake:// 产物与模型证据只验证协议调用，不证明实际业务产物正确。Outbox 保持 pending，未进行真实渠道发送或回读。真实生产授权、业务验收、迁移切换、发布与性能生产收益均不由本轮证明。
