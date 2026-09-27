# 第 37 轮交付范围审查

只读审查当前工作树；未提交、未 push、未更改产品代码。以下文件组是交付闭包，建议同一 PR 内按组提交，不能把 A 组测试与 B 组依赖分开遗漏。现有真实业务结果沿用 round-35/36，不重发流水线。

## 阻塞与边界

- 三个新增核心模块仍未跟踪：execution-local-acceptance.js、execution-maintenance.js、execution-recovery-policy.js；tracked 源码已直接导入，遗漏即不可运行。
- docs/tmp 未整体忽略，存在备份、配置、会话及编译产物。禁止整体 git add；本审查未读取其内容，所有 docs/tmp 路径排除提交。
- test 直接导入 acceptance/scripts 下 configure-frontend-review-checks、prepare-task-uat-configuration、read-uat-delivery、reconcile-prepare-failure、prepare-backend-unit-checks；这些脚本是测试闭包，不是可随意丢弃的临时文件。
- git diff --check 当前失败：execution-store-worker.js:948、workflow-uat-merge-platform.js:176、test/task-workflow.test.js:407 文件末尾多余空行。提交前应清理这三个格式问题。
- 非 tmp 候选新增文件无大于 500 KB 文件，无 sqlite/db/jar/class/tgz 等产物；基础敏感值规则仅命中测试文件，不能替代最终 staged diff 人工审查。
- packages/dingtalk-dsh-assistant/package.json 的 files 为 *.js，新增核心模块会被 npm 打包；仓库根 scripts 为外部运维工具，安装插件包不自动包含，须随 Git 交付。

## A 产品源码及配套测试

- `packages/dingtalk-dsh-assistant/execution-controller.js`
- `packages/dingtalk-dsh-assistant/execution-delivery.js`
- `packages/dingtalk-dsh-assistant/execution-git.js`
- `packages/dingtalk-dsh-assistant/execution-local-acceptance.js`
- `packages/dingtalk-dsh-assistant/execution-maintenance.js`
- `packages/dingtalk-dsh-assistant/execution-pr.js`
- `packages/dingtalk-dsh-assistant/execution-recovery-policy.js`
- `packages/dingtalk-dsh-assistant/execution-session.js`
- `packages/dingtalk-dsh-assistant/execution-store-worker.js`
- `packages/dingtalk-dsh-assistant/execution-store.js`
- `packages/dingtalk-dsh-assistant/execution-task-plan.js`
- `packages/dingtalk-dsh-assistant/execution-workspace.js`
- `packages/dingtalk-dsh-assistant/http.js`
- `packages/dingtalk-dsh-assistant/message-context.js`
- `packages/dingtalk-dsh-assistant/message-model.js`
- `packages/dingtalk-dsh-assistant/resident.js`
- `packages/dingtalk-dsh-assistant/task-owner-controller.js`
- `packages/dingtalk-dsh-assistant/task-owner-session.js`
- `packages/dingtalk-dsh-assistant/task-owner-store.js`
- `packages/dingtalk-dsh-assistant/task-uat-pr-merge.js`
- `packages/dingtalk-dsh-assistant/task-workflow.js`
- `packages/dingtalk-dsh-assistant/workflow-engineering.js`
- `packages/dingtalk-dsh-assistant/workflow-notifications.js`
- `packages/dingtalk-dsh-assistant/workflow-platform-clients.js`
- `packages/dingtalk-dsh-assistant/workflow-release-platform.js`
- `packages/dingtalk-dsh-assistant/workflow-service.js`
- `packages/dingtalk-dsh-assistant/workflow-trusted-platforms.js`
- `packages/dingtalk-dsh-assistant/workflow-uat-merge-platform.js`
- `packages/dingtalk-dsh-observer/web-client.js`
- `test/bootstrap-workflow-maintenance.test.js`
- `test/configure-frontend-review-checks.test.js`
- `test/configure-project-local-acceptance.test.js`
- `test/deploy-owner-repair.test.ps1`
- `test/deployment-integrity.test.js`
- `test/execution-delivery.test.js`
- `test/execution-engineering-repair.test.js`
- `test/execution-local-acceptance.test.js`
- `test/execution-pr.test.js`
- `test/execution-session-native.test.js`
- `test/execution-store.test.js`
- `test/execution-task-plan.test.js`
- `test/execution-workspace.test.js`
- `test/local-acceptance-background.test.js`
- `test/local-acceptance-merge.test.js`
- `test/local-acceptance-project.test.js`
- `test/local-acceptance-readonly.test.js`
- `test/local-acceptance-review.test.js`
- `test/platform-host.test.js`
- `test/read-uat-delivery.test.js`
- `test/reconcile-prepare-failure.test.js`
- `test/task-discovery.test.js`
- `test/task-owner-store.test.js`
- `test/task-workflow.test.js`
- `test/verify-dataset-unit-tests.test.js`
- `test/workflow-engineering.test.js`
- `test/workflow-platform-clients.test.js`
- `test/workflow-release-platform.test.js`
- `test/workflow-service.test.js`
- `test/workflow-trusted-platforms.test.js`
- `test/workflow-uat-failure-continuation.test.js`
- `test/workflow-uat-merge-platform.test.js`
- `test/workflow-uat-proof.test.js`
- `test/workflow-uat-rebuild-proof.test.js`

## B 可复用运维与验收脚本

- `docs/acceptance/topic-context-completeness/scripts/check-repair-deployment.mjs`
- `docs/acceptance/topic-context-completeness/scripts/configure-frontend-pipeline-timeout.mjs`
- `docs/acceptance/topic-context-completeness/scripts/configure-frontend-pipeline-timeout.test.mjs`
- `docs/acceptance/topic-context-completeness/scripts/configure-frontend-review-checks.mjs`
- `docs/acceptance/topic-context-completeness/scripts/deploy-owner-repair.ps1`
- `docs/acceptance/topic-context-completeness/scripts/prepare-backend-unit-checks.mjs`
- `docs/acceptance/topic-context-completeness/scripts/prepare-task-uat-configuration.mjs`
- `docs/acceptance/topic-context-completeness/scripts/prepare-uat2-project-configuration.mjs`
- `docs/acceptance/topic-context-completeness/scripts/read-uat-delivery.mjs`
- `docs/acceptance/topic-context-completeness/scripts/reconcile-frontend-uat-timeout-native.mjs`
- `docs/acceptance/topic-context-completeness/scripts/reconcile-pr371-merge-native.mjs`
- `docs/acceptance/topic-context-completeness/scripts/reconcile-pr371-native.mjs`
- `docs/acceptance/topic-context-completeness/scripts/reconcile-prepare-failure.mjs`
- `docs/acceptance/topic-context-completeness/scripts/recover-owner-frontend-native.mjs`
- `docs/acceptance/topic-context-completeness/scripts/recover-pr371-maintenance.ps1`
- `docs/acceptance/topic-context-completeness/scripts/recover-pr371-merge-maintenance.ps1`
- `docs/acceptance/topic-context-completeness/scripts/recover-pr371-once.mjs`
- `docs/acceptance/topic-context-completeness/scripts/run-uat2-project-acceptance.mjs`
- `scripts/bootstrap-workflow-maintenance.mjs`
- `scripts/configure-project-local-acceptance.mjs`
- `scripts/deployment-integrity.mjs`
- `scripts/local-acceptance-merge.mjs`
- `scripts/local-acceptance-project.mjs`
- `scripts/local-acceptance-readonly.mjs`
- `scripts/local-acceptance-review.mjs`
- `scripts/LocalAcceptanceBackground.java`
- `scripts/verify-dataset-unit-tests.mjs`

## C 接口设计运维文档

- `docs/api/workflow-node-contracts.md`
- `docs/manual/observer-design.md`
- `docs/ops/dataset-local-acceptance-startup.md`
- `docs/ops/dataset-web-local-acceptance-startup.md`
- `docs/ops/execution-foundation-local.md`
- `docs/ops/local-acceptance-merge.md`
- `docs/ops/local-acceptance-review.md`
- `docs/ops/resident-review-local-deployment.md`
- `docs/ops/trusted-platform-workflows.md`
- `docs/spec/bootstrap-workflow-maintenance.md`
- `docs/spec/dataset-web-local-acceptance-integration.md`
- `docs/spec/delivery-readonly-recovery.md`
- `docs/spec/development-uat-reexecution.md`
- `docs/spec/development-uat-validation-review.md`
- `docs/spec/engineering-read-page-limit.md`
- `docs/spec/engineering-read-path-correction.md`
- `docs/spec/engineering-remote-read-recovery.md`
- `docs/spec/engineering-uat-target-routing.md`
- `docs/spec/frontend-uat-timeout-recovery.md`
- `docs/spec/local-acceptance-shared-uat.md`
- `docs/spec/maintenance-bootstrap-switch.md`
- `docs/spec/pr-delivery-phase-evidence.md`
- `docs/spec/run-budget-continuation.md`
- `docs/spec/task-engineering-failure-repair.md`
- `docs/spec/task-execution-duration.md`
- `docs/spec/task-owner-engineering-evidence.md`
- `docs/spec/uat-approval-visible-receipts.md`
- `docs/spec/uat-failed-pipeline-continuation.md`
- `docs/spec/web-stage-confirmation.md`
- `docs/spec/workspace-add-add-conflicts.md`
- `README.md`

## D 验收证据

选择 docs/acceptance/topic-context-completeness/goal.md、matrix.csv、round-20.md 至 round-37.md 与其 round-* 子目录内的脱敏证据；同步 execution-duration-deployment.md、local-deployment-uat-duration.json、prepare-failure-reconciliation.md。事故脚本绑定的 manifest 与其摘要原文必须保留，不能单独修改 JSON 破坏哈希绑定。提交前逐份人工审阅 JSON/log 内容；本轮仅作基础模式扫描，未宣称全部证据已完成敏感性审查。

## 最小提交前组合测试

使用 Node 24，显式文件清单，不跑全量。

```powershell
& D:/soft/node-v24.19.0/node.exe --test --test-concurrency=2 test/execution-store.test.js test/execution-delivery.test.js test/execution-pr.test.js test/execution-workspace.test.js test/execution-local-acceptance.test.js test/execution-engineering-repair.test.js test/workflow-service.test.js test/workflow-uat-failure-continuation.test.js test/workflow-trusted-platforms.test.js test/workflow-uat-rebuild-proof.test.js test/task-owner-store.test.js test/task-workflow.test.js test/deployment-integrity.test.js test/configure-frontend-review-checks.test.js test/read-uat-delivery.test.js test/reconcile-prepare-failure.test.js docs/acceptance/topic-context-completeness/scripts/configure-frontend-pipeline-timeout.test.mjs
```

本组覆盖跨模块核心恢复、Owner 收口、交付幂等、UAT 失败续跑、部署完整性及 docs/scripts 导入闭包；此前 Java/浏览器真实验收不重跑。另执行 git diff --check 与 goal 校验。测试结果由主代理实际运行后另行记录，本审查不声明已通过。

## 不应混入

- docs/tmp/** 全部排除；不删除其内容，不归档凭据或完整数据库。
- 无关业务仓库代码、用户工作目录、安装态 node_modules 不属于本 PR。
- 钉钉认证属于运行账号状态；登录恢复不应把登录令牌、二维码、账号缓存放入仓库。

## 补充：证据字段扫描

对 round-24/25/30–36 的 JSON/log 做敏感字段名扫描，仅命中 credentialPrinted、credentialsRead、authorizationBasis、authorizationText、notificationAuthorization 等审计字段，以及测试标题；未发现 access/refresh token、password、cookie 等凭据字段。仍须最终 staged diff 人工核对，尤其不能误加 docs/tmp。

主代理已运行 10 文件组合；余下补充范围：execution-store、execution-pr、execution-workspace、workflow-uat-rebuild-proof、task-owner-store、task-workflow、configure-frontend-review-checks、read-uat-delivery、reconcile-prepare-failure，以及 configure-frontend-pipeline-timeout.test.mjs。无需重复已跑组合。
