# 第一轮

修复前正式 HTTP 返回 409 / WORKFLOW_WEB_ACTION_UNSUPPORTED，HTTP workflowTaskAction 在 archive 的服务转发前拒绝。Service 与控制账亦缺失归档动作，不是旧 Runtime 工作目录归档函数的报错。

定向归档测试 3/3，通过正常入口、严格空对象、本机来源、非法身份、幂等、重开数据库持久化、节点/工件和通知不变、运行及等待拒绝。取消后用正常 recover 收口 Owner 状态，再归档成功；仅 Run 终态不冒充任务完成。

HTTP 与 Service 回归 152/152；控制库与任务计划 45/45；效果及旧版工作目录 22/22。部署和正式批量归档尚未执行。
