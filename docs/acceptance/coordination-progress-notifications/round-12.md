# 第12轮：最新主线部署与菜单修订续办

2026-10-29：获取最新origin/main@56483462（已含PR287/288），在当前隔离分支合入后打包双包。Assistant SHA256 c8bc19cc8417e7516af731e50b0a60b846acec45b5e746117f88dc7572d86ee4，安装独立核验89文件；Observer独立包核验通过。按原生部署脚本Check零写→原生SIGINT→同profile安装→计划任务启动，旧PID39508、新PID32840，3080/18998同进程，inboundProcessing/DWS正常、真实任务/待答复分页就绪。32个归档任务仍可查，旧2条unknown告警保持。停止后精确核验并清理捕获的孤立DWS _bus进程33932，未杀业务执行。

验证：话题路由原生13/13；当前协调暂停定向1/1。release-smoke首轮暴露main映射未同步，更新后324文件、3历史、0删除，逐项分类/Release/分组完全一致，仅移除Host不再静态导入的三个协调模块边。再次smoke其余12通过，真实包用例因并发资源超过原30秒预算取消；独立重跑包用例2/2通过（18.6s/9.8s），保留首次超时。误跑整个旧独立协调集成集导致启用假设用例超时，已停止；现行暂停合同定向实跑通过，不声称旧启用全集通过。未触发CI。

正式Web任务输入upr-menu-followup-20261029创建task-85f7a647b6643a866b7ead15b756f54e，session task-session-0f592696-8b1b-41ad-a1ad-061f0e61ed84；关联原topic-0fe522bbcccb91bc093f62be12bc49f8/revision8。原任务4a0e已完成并物理归档，后续展示修订未实施，故用正式新修订任务承接，未解封原档案或重放群消息。原始消息核验李辰要求仅留下载模版/导出数据项/导入数据，并明确外部导出全部UPR也去掉展示；范围不包含UAT或生产部署。

创建后独立GET回读state=running、drained=false、无blockers；目前Owner已接纳，实际实现交付仍待核验。证据docs/tmp/local-deploy-20261029、upr-buttons-topic-before.json及upr-buttons-followup-{input,created,live}.json。

## 续办最终验收（2026-10-29 02:01）

原任务于01:58正式completed/drained，两个原执行及自有操作均收口，无待答复。独立只读回查业务仓：工作树干净，HEAD及远端worktree-upr-merge-source均40cb884e4cbbdc4e0bfa858dae6c35040f1412de，parent c56df87d；gh pr view392实回OPEN/head同SHA。生产改动仅移除额外菜单三行，底层能力保留。

实际读取原验收文件：browser-4/automatic.json status PASS/failures空；upr-callbacks.json、form-draft.json及production-build.json均completed/exitCode0/candidateUnchanged true。delivery.md记录12自动+2视觉、10组定向回归、生产构建756.63秒与7条既有警告；原生构建job_output已收取completed/0。没有重复构建。真实账号/后端/共享数据未验；本次未合main、未部署UAT/生产。证据根D:/baibu-agent/tasks/task-85f7a647b6643a866b7ead15b756f54e/docs/acceptance/upr-menu-round-3。

SG14本地部署与SG15后续修订均完成，停止upr自动跟进。原归档档案未修改。
