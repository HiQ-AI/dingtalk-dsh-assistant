# Round 16 — 工程补充输入与检查排空可靠性

## 范围和结论

本轮只修复已准入工程流程的代际交付、验证检查取消和重启排空屏障。Git 实测使用本地 bare，PR 使用隔离 fake gh 协议；没有向真实 GitHub 或钉钉发送修改。

发现并修复：原 registry 同任务固定分支同时固定 `expectedRemoteSha=null`，第一代 push 后补充会在下一代 `preparePush` 遇到 `GIT_REMOTE_CONFLICT`。仅更换错误码或无条件 force push 都不能解决。

## 实施

- `workflow-engineering.js`：受信 `prepare-generation` 从控制账历史成功 push 取上一交付 SHA，独立检查远端任务分支仍是该 SHA，冻结派生 `baseCommit/expectedRemoteSha` 作为节点持久输出。下一代受管目录从上一已交付受管仓库提取该提交。没有前次 push 时仍使用初次冻结基线。
- `task-workflow.js`：所有后续节点明确依赖派生输入。提交、PR 标题和正文使用当前请求及本次真实文件/验证证据。
- `execution-pr.js`：续代只允许带上一成功 operation marker 的 OPEN PR；更新原 PR 后独立读回。ACK 丢失仍先回读，不再 create 第二张。远端漂移、旧 PR 关闭、身份不匹配均拒绝继续。
- `execution-check-job.js`、`execution-candidate.js`：AbortSignal 贯通；取消/超时终止进程树，等待 close；taskkill 失败或 15 秒内未收到排空回执抛 `executionDrained=false`，不吞错误。
- `execution-controller.js`：检查节点 `drainPolicy=external-process` 进入定义 digest。持久 `drained=false` 的检查即使独占 Store 重启也拒绝 recover 自动放行，返回 `EXECUTOR_DRAIN_EVIDENCE_REQUIRED`。纯代码节点保留原恢复语义。

## 实跑

```powershell
node --test test/workflow-engineering.test.js
node --test test/execution-controller.test.js test/execution-pr.test.js
```

- registry 2/2 PASS。真实两代交付耗时 104097 ms：第一代 PR 创建后在 finalize 等待；接纳新输入；第二代确实读到第一代文件内容；新 commit 的 parent 等于第一代交付 SHA；同任务分支快进；PR create=1/edit=1、编号不变；最终 title/body 是第二次请求；源仓库仍为旧内容。
- Controller + PR/check 21/21 PASS。取消与超时两个用例启动真实 Node 父子进程，返回后独立 `process.kill(pid,0)` 验证两 PID 均不存在，后续检查 step 没有执行。
- Windows Store 重启反例：真实父子进程仍存活，模拟未取得终止确认；同进程 recover 与 Store 关闭重开后的 recover 均拒绝，`drained=false` 持久保留，下游调用 0 次。测试收尾显式停止合成父子进程并独立验证消失。该 Windows 用例在非 Windows 环境明确 skip，不声称已验证其它 OS。
- 先前组合 `task-workflow + registry + execution-pr` 8/8 PASS（之后新增的代际/排空用例由上列定向命令覆盖）。

## 边界

- 主机在外部检查执行中崩溃时，当前实现保守阻断；未提供自动证明旧 OS 进程退出的机制，也没有忽略屏障开关。必须取得独立进程排空证据才能设计受信后续收口，不能把 SQLite 独占锁当 OS 退出证明。
- 本轮未新增后台守护进程检查支持。受信检查应以前台命令运行；自身逃逸、重托管的后台服务不在进程树取消能力的声明内。
- 父任务已在 `workflow-service` 阻止 waiting 节点 `ENGINEERING_VERIFICATION_FAILED` 的周期自动重跑，并投影具体节点等待原因；父任务回报相关 15/15 通过（该命令不是本子任务重复执行的证据）。`node.commit` 的具体 wait reason 存于节点，不能仅依赖 run.recoveryReason 判断。
- 没有重新测真实模型端到端；本轮不修改模型调用协议。Round 14 的真实 provider 证据仍仅针对当时那一轮，不代替本轮隔离协议测试。
