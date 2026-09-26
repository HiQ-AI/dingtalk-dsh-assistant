# 第四轮定向验证与本地部署

2026-09-25。本轮验证新日常 Task 的 Owner 单一规划、受信只读步骤与本地 v2→v3 切换。没有为验收发送钉钉消息、发起 UAT/生产动作或写业务数据库。

- `node --test test/workflow-service.test.js test/task-general-workflow.test.js test/task-owner-session-native.test.js test/execution-task-plan.test.js test/execution-controller.test.js test/workflow-engineering.test.js test/message-workflow.test.js test/workflow-approval.test.js test/execution-store.test.js test/workflow-data-change-external.test.js test/task-release-workflows.test.js`：197/197 PASS。涵盖同一 Task 四阶段编排、Owner 强杀恢复、新日常 Task 的单代码 Run、连续两步、重复提案、来源编辑、文件只读与消息附件的精确来源绑定及独立回读。
- 修复本地启动暴露的两处问题后，`node --test test/workflow-entry.test.js test/platform-host.test.js test/workflow-service.test.js`：78/78 PASS；`node --test test/workflow-service.test.js test/workflow-entry.test.js`：71/71 PASS；`node --test test/workflow-service.test.js test/task-release-workflows.test.js test/workflow-data-change-external.test.js`：84/84 PASS。Cordis Resident 现声明平台客户端依赖；历史定义仅为非终态 Run 重建并保持严格摘要核验。

<a id="t14"></a>T14（部分）：新建日常 Task 先经纯代码 intake，Owner 选择受信单步能力，Host 以单代码节点执行、独立 verify，再由 Owner 决定追加步骤或最终报告；重复步骤和编辑后旧范围均拒绝。默认可整理当前授权消息为 Markdown 内容地址产物；受信文件读取需 Host 配置绝对根及路径白名单，当前本机未授权；平台消息附件读取需 DWS 精确消息及资源双回读，合成适配器通过，尚未用真实附件验证。物理文件写入与任意平台查询没有受信效果适配器，相关目标继续明确阻塞，不能宣称通用日常能力全部可用。

<a id="t30"></a>T30：停机前零写迁移自检报告 v2、1 个 Task、5 个 Run、未知效果 0、待审批 0；38 条通知中 37 条已送达、1 条已取代，无待发送。停止旧 PID `29912` 与其两个 DWS 子进程，保留旧插件目录。`scripts/migrate-task-owner-store.mjs --execute` 使用 SQLite 一致性备份 `D:/dsh_home/workflows/runtime-v2/control.sqlite.pre-task-owner-v3-b2e9d52e-ada6-4b4e-aee7-497c049d4c3c.sqlite`，独立回读旧备份 v2、新库 v3，双方 `integrity_check=ok` 且 Task/Run 数仍为 1/5。精确包 `docs/tmp/task-owner-package-final4-20260925/zzusp-dingtalk-dsh-assistant-0.5.15.tgz` 的 SHA256 为 `ECA40658484AE20B5B8FAE29F521873FCC005C3ED0776B77FC04E6898A5AB369`。DSH CLI 安装后，76 个 JavaScript 文件逐项与源码哈希相同。新 PID `34688` 监听本地 `18998` 与 `3080`，两个 DWS 子进程存在；`18998/health` 返回 200、`status=ok`、`recoveryIssueCount=0`，工作流目录可读取。独立 SQLite 回读 v3、`integrity_check=ok`、1 个成功 Task、5 个成功 Run、38 条通知，旧任务及通知数量未增加。

本轮运行态证据证明本地实例加载及历史账恢复，不证明真实新消息路由、钉钉渠道送达、真实附件读取、UAT 部署或业务 E2E 已执行。
