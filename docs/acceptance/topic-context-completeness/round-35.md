# 第 35 轮：证据读取与远端查询修复后续验收

状态：进行中，尚未完成双链验收。

## 恢复范围

- 后端 UAT3 已完成三原生阶段及流水线 277、镜像、Pod、入口回读；本轮使负责人读取同运行的业务验收与清理原始材料，再由原生完成门禁结案。
- 前端 UAT2 保留 round-34 原运行、开发分支和已应用修改，仅恢复因远端引用读取超时而等待的检查节点。
- 不重发已经成功的 PR 修改、合并、推送或后端流水线。

## 修复与部署前证据

- 批准回执及 Web 请求展示定向测试 15/15。
- 只读远端引用重试、服务恢复和冻结定义复原测试 20/20。
- Owner 原生会话 5/5、工程证据 1/1、修复夹具 2/2。
- 固定原生恢复工具 5/5；分阶段维护测试 8/8，既有维护测试 5/5。
- 唯一安装包 SHA256：`d8f2f315151c5c7b3798b4ad4d7684849150908ea2afc9b2d5f14bb78fd8ffda`。
- 现场零写预检通过，84 个包内文件与当前源码一致；所有节点、负责人、效果、消息均已排空。

后续阶段证据继续追加；未完成前不写全绿报告。

## 本地部署与续跑

12:52：正常维护 enter/drain/seal 后完成离线备份校验；原生 Owner 事件及前端 run.recover 完成，远端写入 0。安装 84 文件一致，完整 profile SHA 不变，新 PID27236；16 任务、76 旧节点、17 旧运行及68历史任务一致。Web 200、恢复问题0，解除维护 revision15。钉钉监听仍 degraded/inboundProcessing=false，独立保留此边界。

12:54：后端 Web 状态 completed，Owner decision=complete，event/processed watermark=76，三阶段 succeeded。前端同原 run/generation 正在 verify-candidate，实际启动 Node22 Yarn 依赖安装。

后端独立最终回读通过，详见 round-35/backend-final-readback.json 及 backend-uat-readback.json：22/22 测试、1 t 持久化与数据/进程清理、全部30节点成功；PR371/UAT3/提交3ea89c0、流水线277、镜像及Ready Pod摘要一致、HTTP200。C33 round-35=PASS。通知证据为机器人接口成功日志，不等同群内消息独立回读。前端 round-34 因远端引用超时失败记 C34=FAIL，round-35 保持 NOT_RUN 至实际闭环。

13:09：前端同候选98c4ffe4正式检查通过，依赖194436ms、17项测试全部通过、构建765048ms，共959645ms；证据 frontend-native-checks.json。本地验收identity 50c5fad5633b360c7a5a38cd9b4440a6b8c008f6dadc537e61b1130110d4a4d1 已开始。13:14后端依赖及前端启动中，尚无业务或清理终态。

13:29：前端真实页面验收 saved/restored/browserStorageCleared 全部true，8阶段成功；本地端口58052/51424无监听，进程10124/6472均退出。提交d1e447787201212140a2732b798d336965ddfaa7已推送原开发分支，PR368独立回读OPEN、base=feature/uat2-base。开发阶段succeeded，继续原生UAT合并/部署。证据frontend-local-acceptance.json、frontend-cleanup-readback.json。

13:31：PR368已MERGED，base UAT2，head=merge=d1e447787201212140a2732b798d336965ddfaa7。stage2原生成功，stage3 run-af0faccc53bd7734ec508c8ab5e494c7f1d67749053078bc47ee570a8916bdf0 已进入提测。使用既有用户授权批准实际UAT2请求，API applied=true、独立列表answered/approved；本轮批准回执和请求可见性真实路径通过。继续精确版本部署回读。

13:42：前端流水线319 killed，started→finished恰600秒。clone445秒、build142秒均成功；restart仅9秒即终止，notify killed。C34 round-35=FAIL，不写全绿报告。产品当前只读reconcile将终态失败仍保持unknown，正在修复可信失败收口及同原任务仅第三阶段重建接续，并先独立核对实际镜像/部署防止误重发。
