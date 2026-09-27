# 第 36 轮：UAT2 超时失败后的原任务接续

状态：进行中。保留第35轮 C34 失败记录，不将部分部署视为流水线成功。

## 现场与动作

#319 在600秒时 killed，源码拉取445秒、镜像构建142秒成功，部署步骤9秒后终止、通知未完成。独立回读实际 UAT2 已运行 d1e4477 对应镜像且 Ready/HTTP200；仍未满足全链完成条件。

1. 仅将 Woodpecker `HiQ-AI/dataset-web`（repo2）的仓库级流水线时限从10分钟改为30分钟，其他字段不变。此设置影响该仓库后续流水线，覆盖网络拉取、构建、部署与通知总时间。依据是本轮已验证的实际耗时；API契约见 [官方 API](https://woodpecker-ci.org/api)，分钟单位见 [官方服务端说明](https://woodpecker-ci.org/docs/administration/configuration/server#default_pipeline_timeout)。
2. 固定工具先检查repo/分支/提交/#319终态、管理员权限、列表完整且无活动流水线；变更意图排他落盘，PATCH只发一次，独立GET确认30分钟。读取失败或不确定写入不能盲目重发。
3. 安装可信终态失败收口与原任务受限重建接续修复，保留已经成功的工程和合并阶段；重建继续原有预检、批准和精确镜像交付验证。

## 已验证

超时配置工具5/5隔离测试通过，现场 `--check` 零写检查通过，仍为10分钟。产品与部署证据随后追加。

配置随后已执行唯一一次 timeout-only PATCH，独立 GET 和再次零写 `--check` 均确认30分钟。证据 frontend-timeout-change.json、frontend-timeout-readback.json；没有触发流水线或修改其他字段。

14:06：新包597544fd已部署，84文件、profile39738及19旧终态运行/76历史节点一致；PID29228、Web200、恢复问题0，维护revision18解除。恢复时远端写0，独立比较19其它运行/328其它节点/49其它效果/12业务任务/34阶段/11Owner及legacy均未变。原失败部署run正式failed，原任务stage3自动改为task-uat-rebuild，run-b351d464289527ed63dc4c4e69f36d4d0f58f7591c1078da323a6f97b3453876；工程与合并原run/output保持。实际重建预检通过并批准对应请求，API与独立回读均approved。

## 业务全链最终回读

14:20：C33/C34 round-36=PASS。后端 UAT3 #277 再次独立回读通过；前端 UAT2 #320 成功，原任务已 completed/succeeded、Owner complete，水位83/83。原工程/合并两阶段的run与output完整保持，旧部署run仍failed、#319 killed收据保留；新重建7节点全部succeeded/drained，唯一effect的begin/started各一次。不存在重复开发、重复合并或重复发送。

- 后端：22项专项测试、实际业务合并结果1 t、数据与进程清理；PR371→feature/uat3-base，commit3ea89c0d4daf970a5be9b8a7d40e7ec81f2da842，pipeline277；本轮backend-uat-readback.json通过，原始业务/任务证据见round-35/backend-final-readback.json。
- 前端：17项专项测试和生产构建，真实页面自定义维度草稿保存/离开/恢复/浏览器清理；PR368→feature/uat2-base，commitd1e447787201212140a2732b798d336965ddfaa7，pipeline320；精确镜像sha256:3d0e28ee6db7f6ca1373baac10845371f77512d149831645c00537bfca6513dc与Registry/Ready Pod一致，入口HTTP200，通知step4463成功。
- 两项Web终态：both-tasks-final-readback.json；前端独立流水线及原生账：frontend-uat-readback.json、frontend-final-readback.json。通知证据为机器人接口成功，未独立回读钉钉群消息。

## 收尾展示缺陷与边界

前端真实终态已完成，但API仍携带旧DELIVERY_RECONCILIATION_REQUIRED，界面会显示过时等待提示。正在修复只读投影，不改历史执行或业务结果。D盘剩余约1.619GB，备份约577.9MB加1GiB余量已需1.652GB（未计新包）；部署门禁暂不满足，不停止实例、不降低余量、不自动删除文件。两条业务链通过与该展示修复尚未部署分别记录。平台钉钉入站监听仍degraded/inboundProcessing=false，不能声称平台整体健康。

完成态提示修复已完成，6/6定向回归通过，README已同步。新包26af8b66共84源码文件一致。实际执行部署脚本 -Check 拒绝：可用1,618,116,608字节，所需1,656,723,193字节，缺38,606,585字节。未进入维护、未停止实例、未安装新包；当前仍为597544fd/PID29228。证据completed-task-waiting-projection-tests.log及completed-waiting-deploy-check.json。用户已收到释放至少200MB的资源请求；未删除任何文件，也未降低安全余量。

## 17:53 空间释放后完成部署

用户释放D盘后重新执行零写-Check：可用11,784,175,616字节、所需1,656,723,193字节，84文件与26af8b66包一致。正常维护/封存/离线备份验证后安装，新PID19944，配置摘要保持39738ce3；16任务、76旧节点、21旧终态运行及68legacy校验一致。Web认证200、恢复问题0，维护revision21已解除。启动超过首个30秒等待，通过同一launch零写回读继续，未重复安装或重启。

实际API两任务均completed/succeeded、Owner complete；waitingReason、stageConfirmation、budgetContinuation均为空。原水位后端76/76、前端83/83不变。本次未重跑业务或触发UAT流水线。展示修复部署已闭环，证据completed-waiting-deployment-readback.json与completed-waiting-live-readback.json。钉钉入站仍degraded/inboundProcessing=false，作为独立未解决边界保留。
