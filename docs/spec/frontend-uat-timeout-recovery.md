# 前端 UAT 超时效果的固定范围维护恢复

## 当前事实与目标
前端原部署阶段 run-af0faccc53bd7734ec508c8ab5e494c7f1d67749053078bc47ee570a8916bdf0 的 execute-build 唯一 unknown 操作对应 commit d1e447787201212140a2732b798d336965ddfaa7；Woodpecker repo2/#319 总计600秒后 killed。构建及运行镜像已独立核对，但通知 killed，不能写成功。

本次工具只将该既有未知效果原生只读对账为 failed，保留所有失败证据。随后同代原生 run.recover 排队并封存维护，安装新产品后让 Controller 正常消费明确失败，交由正式阶段接续/重建处理。工具不执行、重发或触发任何远端操作。

## 身份和维护边界
固定 manifest 绑定实例ID、原PID27236、task/run/workflow/requirement/node/input/effect/operationKey、冻结平台目标及唯一pipeline319 killed事实。查询时要求同提交无成功或在途等价流水线，远端PR368、UAT2 ref仍精确d1e447；否则停止。

复用 recover-pr371-merge-maintenance.ps1 增加 frontend-uat-timeout scope，证据仅放 docs/tmp/frontend-uat-timeout-incident。容量、原进程见证、profile/package CAS、独占锁、完整备份核对和正常维护封存不放宽。未知效果只在已排空进程完整退出、备份验证后通过 native Delivery.reconcile→effect.observe→run.recover→maintenance.seal 收口，禁止SQL更新。中断只读检查现状，不重新发送。

## 验证
隔离控制账/模拟只读适配器验证精确失败证据、节点身份、维护许可、无execute、错误/漂移保留unknown、完成后幂等。PowerShell AST验证三个scope分离、容量/备份/封存顺序及PID绑定。现场只运行零写check；真正offline/reconcile/install/start由主代理执行。
