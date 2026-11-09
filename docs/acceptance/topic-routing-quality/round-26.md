# 第26轮：修复 Resident 消息关联任务查询

日期：2026-11-09

## 结论与范围

用户反馈 `无法连接 resident 插件：observer_source_task_refs_unavailable`。本机两个会话的消息分页均实际返回 HTTP 503；群摘要和 health 接口仍可访问。Task 服务已实现来源关联查询，Resident 启动接线缺少该方法，造成消息分页和完整群详情不可用。

本轮仅补齐 `runtime.sourceTaskRefs = tasks.sourceTaskRefs`，保留原有按群、来源、消息版本和每批最多100个来源的查询与错误边界；不以空关联列表吞错，不修改数据库、业务消息、任务或通知。README及现有部署核验说明同步更新。

## 源码与真实验证

基础提交为合并后的 `4b88bff8bf5ba6efe083823dcb1dfd9ad7392eba`，修复分支为 `worktree-observer-source-task-refs`。验证绑定未提交源码：Resident blob `d5c89a36e6ac2edfe6d70fe92bac389c3a915352`，Service Native测试 blob `97c886a3fd2c9b8d517ee1642becf46e4d27e301`。本轮开始已有第25轮goal/matrix/report及部署证据未提交，另有未知stackdump，均保留。

- 修复前真实插件启动回归：0/1，消息页精确返回 `503 observer_source_task_refs_unavailable`（任务 `b74vy94dw`）；首次种子准备因Domain未关闭失败，先修复夹具生命周期后取得此有效基线。
- 修复后 Native定向：3/3，0 fail/cancel/skip，9263.2875ms（任务 `b5du0oy93`）。包括真实 `resident.apply` 启动后的非空来源分页、完整群详情及已取消Task的精确关联；原来源/跨群/归档合同，以及监听启动失败清理与同库重开。无模型调用，无真实外发。
- `node --test test/http.test.js`：53/53，0 fail/cancel/skip，8906.6482ms。覆盖来源版本精确关联、读取失败503及原有权限/CAS边界；HTTP实现未改。
- `node scripts/test-suites.mjs check`：345文件各一次，historical5，deleted0；未调整映射或退出任何合同。
- 显式原生profile与实际三包目录后，`pnpm test:release-smoke`：14/14，0 fail/cancel/skip，57788.9723ms（任务 `bxiniusva`）。实际解包的个人Skill任务business28948ms，Resident health business8491ms，均未abort。首次由Git Bash的GNU tar误读Windows盘符路径而失败；仅本次PowerShell子进程优先使用Windows原生tar后，同一三包通过，未修改全局PATH或放宽时限。

## 包身份

| 包 | 字节 | SHA256 |
| --- | ---: | --- |
| dingtalk-dsh-assistant-2.3.0.tgz | 55437 | 06dc1a0819031324bd60efadabb929b254fc1045466bd044f0759507337b8add |
| zzusp-dingtalk-dsh-assistant-2.3.0.tgz | 550634 | 574a780b96399d10738e5a3f78f1a0191645717ebeb49c0b1c24a594d62af31b |
| zzusp-dingtalk-dsh-observer-2.3.0.tgz | 62783 | d147a380d7e982e4a66280d65f024628ee2759118e53bca2718db3479dad961f |

三包由当前冻结源码使用pnpm10.13.1分别执行pack生成；Observer源码未变，其包摘要与上轮一致。包为本地候选，不是已发行的npm版本；不触发CI或tag。最终包/安装/运行态证据在本轮部署阶段结束后集中回填。再生成方法沿用第24轮，但必须按新源码重新核对摘要。

## 本地部署阶段

首次正式脚本 `-Check` 拒绝 `DEPLOY_NOT_DRAINED`。只读账本确认有1个真实执行仍running/drained=false，另有1个active/wait任务；本轮未发停止信号，未安装，旧PID30460及双端口保持可用。等待自然排空后沿原生双包runbook继续，不取消业务任务或为修看板强行重启。

原有health degraded与2条 `LEGACY_DECISION_RECONCILIATION_REQUIRED` 不属于本次接线缺陷，不清除或改写。真实钉钉外发、业务重放、旧账reconcile apply、生产部署及真实模型语义均未执行。
