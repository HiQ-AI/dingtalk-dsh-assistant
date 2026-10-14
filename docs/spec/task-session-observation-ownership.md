# 任务会话查看与写入归属

## 问题及证据

2026-10-14原任务执行会话已提交结果，但统筹lease29没有新Host输入，最后原生事件为end-seed，原生API显示Agent存在但空闲。现场缺少当时页面请求日志，不能直接认定触发请求。

隔离真实SDK复现：SessionController.follow先返回冷会话快照，再自动promote为普通Agent；任务管理器随后因TASK_SESSION_ALREADY_LIVE拒绝新lease，且保持drained=false。此机制完整制造相同外观。track又会在后续未执行工作的kick成功return时清掉原错误，导致健康检查没有暴露故障。

## 修复方案

复用现有task-session-persistence路由，不改会话header、历史事件或任务数据库。已绑定task route的create/open(write)要求Host专属的精确taskId/sessionId写入作用域；使用Node AsyncLocalStorage传播，作用域token在callback结束后撤销，不能通过异步尾巴保留开写权限。校验发生在backend写入之前。

原生task/execution create/resume通过同一runOwned入口，已有写handle后续append/flush仍由原生生命周期管理。read/stat/list/flush不受限，未绑定的普通会话保持原行为。跟随历史时拒绝后台普通Agent激活，但保留snapshot与后续事件流；不热抢Agent，不伪造subagent身份，不修改drained绕过占用。

告警只在真实恢复后解除，任务仍未排空的无操作kick不能抹去此前故障。

## 验证与现场边界

原生follow快照、后台激活拒绝、无新end-seed、同会话下一lease及follow事件连续性；精确身份/撤销/并发作用域；普通会话不受影响；原生task和execution回归。

新修复部署必须先证明现场Agent空闲、无inbox、所有执行已结束；沿原生SIGINT退出和现有同任务恢复路径恢复，不能直接修改SQLite字段。包、安装、进程、健康与原任务真实新输入分别核验。
