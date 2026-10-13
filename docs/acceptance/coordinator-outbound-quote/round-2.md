# 本地部署与原消息恢复

2026-10-13，Assistant 1.0.0 包 SHA256：`68ada5399bef22d1ee3cf0ad185e421f77e3a0c07724fba3774fbb3d45e27930`。按部署 runbook 完成 Check（`ok:true,writes:0`）、安装、Readback（`ready:true`）及 Resume（`dispatchResumed:true`）。普通部署 `backupCreated=false`，无 schema 迁移。

独立回读：新 PID 48028，启动时间 12:45:17 +08:00；双端口由新进程持有，健康 `ok`、inboundProcessing/outboundAuthorized 为 true、recoveryIssueCount=0。部署历史核验通过：7 Task、47 旧节点、27 旧 Run；安装文件与源码及包验证通过。详细控制证据保留在 `docs/tmp/coordinator-outbound-quote-local-20261013-01/`。

12:47:26 +08:00 原协调会话在同一轮成功 commit，两条原来源版本仍为 1、revision 仍为 0，均 settled、routing_complete。短补充消息的 fact 已 applied；原专家审核验证请求的 research 已 applied，并由正常 Task Owner 读取受信查询证据。没有手改控制账、重建原协调会话或重发旧通知。

钉钉独立回读：同一实际配置 profile 的旧登录态一度 `token_refresh_failed`，沿原 profile 正常登录恢复。`dws chat +messages-mget` 回读原消息及引用的旧助手回复，`complete/messagesComplete=true`、failures 为空，群与消息身份均相符。私有结果保留在 `docs/tmp/group-reply-missing-20261013/dws-source-readback.json`。

## 未收敛边界

12:49:04 +08:00 原业务调查报告 action=block、condition.kind=capability：缺少当前 UAT 双专家审核后撤回场景的受信只读业务验证结果，现有源码与当前运行镜像未建立可核验对应，浏览器观察也未复现该流程。因此不能断言该业务问题已修复。

当前 `workflow-notifications.js` 明确静默任务接纳/启动及 capability 内部受阻，只有最终结论、用户资料/权限补充和主动查询等进入群聊。该 Task 没有 prepared/unknown/delivered 新通知，故本轮不能宣称原消息已收到群回复。消息协调恢复通过；业务验证与回复送达为 BLOCKED，不写全绿 report，不以健康或消息 settled 代替渠道证明。
