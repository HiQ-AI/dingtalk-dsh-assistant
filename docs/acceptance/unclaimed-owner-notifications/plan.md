# 旧求助通知失效与发送恢复

目标：即使关闭钉钉外发，同任务后续已应用报告也能让从未领取的旧求助失效；保留当前回复和发送未知历史。现场三条旧求助失效后，按用户授权恢复自动外发并发送指定审核进展回复。

现状：四条通知 prepared/leaseEpoch=0，health.outboundAuthorized=false。旧求助对应任务已有后续 applied 结案报告。canDisclose 拒绝发生在 claim 时效检查之前，造成旧通知一直显示待发送。

复用 message-ledger 与 workflow-notifications：扫描先对 Owner 通知执行事务内 reconcile，再检查披露/发送。只对无发送/操作记录、旧报告 applied、同任务最新 accepted Owner 已 applied 且报告更晚的 wait/block 通知失效；不推断业务全部完成或替代通知已送达。

本地部署首次触发 ENGINEERING_DEFINITION_DRIFT。对照原受信发行包，恢复无语义变化的发行换行字节；冻结摘要相关 helper 的 Git 属性明确保留原字节。通过既有 RepairStoppedLaunch 修复，不修改控制库定义、不放宽漂移守卫。三个纳入提交的字节恢复文件经 HEAD/index 规范化比较，均只有换行差异。

外发配置通过 YAML AST 精确定位布尔值，先零写检查再 SHA CAS 写入；在正式维护排空之后切换，DSH 原生配置热重载恢复健康后解除维护。仅该布尔值从 false 改为 true。现场队列只剩指定查询回复。

定向回归和现场验证以 matrix.csv 为准；额外独立 CLI 认证失败记录在 round-3.md，不替代插件真实发送状态/消息详情回读证据。
