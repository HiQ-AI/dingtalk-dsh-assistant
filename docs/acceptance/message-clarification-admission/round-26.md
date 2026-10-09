# Round 26：SG12 UAT2 样式核查能力诊断

## 范围与结论

本轮仅只读诊断 `task-db056b308e70f46b3cdacfb50e0d7bf4`，没有恢复 Task、操作 UAT2、使用用户浏览器或部署。结论是：当前任务受管查询接口确有浏览器页面证据和部署溯源接入缺口；不能据此声称整台机器或整个 DSH 没有相关能力。没有证据证明另一个已启动的工程执行会话可以直接完成本次核查。

现场 detail（本地 `docs/tmp/task-db056b308e70f46b3cdacfb50e0d7bf4-detail.json`）为 `runSequence=0`、`taskRunId=null`、`stageTasks=[]`、`executionNodes=[]`。因此当前阻塞并非工程执行节点实际尝试浏览器后的失败。Owner 是当前持续负责任务的会话，不能把名称 Owner 理解为另有一个已具备完整工具的执行 Agent。

## 实际尝试证据

原始会话：`D:/dsh_home/sessions/--D-baibu-agent-tasks-task-db056b308e70f46b3cdacfb50e0d7bf4-work-task-db056b308e70f46b3cdacfb50e0d7bf4-owner-owner-f8c1d619be7ada992cb615e749fac61cb7ab8f85--/owner-f8c1d619be7ada992cb615e749fac61cb7ab8f85/session.jsonl`。

| session seq | 实际调用 | 结果与证明边界 |
| --- | --- | --- |
| 26 / 27 | `query_runtime_status(dataset-web-uat2-runtime)` | 成功，generation 422，Pod ready；镜像摘要 `sha256:3d0e28ee6db7f6ca1373baac10845371f77512d149831645c00537bfca6513dc`。不证明页面样式，也不证明对应 PR。 |
| 28 / 29 | `query_project_resource(dataset-code-a8212af,list)` | 成功列出固定后端代码快照；不能替代前端当前部署源码或页面。 |
| 30 / 31 | `query_project_resource(hiq-project-knowledge,search,"363")` | 仅扫描 2 个知识文件，结果为空；不证明 GitHub/构建系统不存在 PR 或溯源记录。 |
| 414 / 415 | `task_owner_submit(block)` | 提交能力阻塞；本轮没有浏览器或部署溯源工具调用。 |

状态证据原件：`D:/baibu-agent/tasks/task-db056b308e70f46b3cdacfb50e0d7bf4/work/artifacts/sha256-99ab59d70fe0ff26806605821810ec7717130227a570afc4b5748fc953c2b25e.json`。其限制明确写明镜像 ID 尚未映射 Git 提交；本轮只读核对了该原件，未将私有正文复制入版本库。

## 实现边界与反证

- `packages/dingtalk-dsh-assistant/task-owner-session.js:122` 定义持续负责本任务的执行会话；`:129` 清空继承工具，`:132` 的 guard 只放行注册查询与 Owner 提交/证据读取。
- `packages/dingtalk-dsh-assistant/workflow-service.js:582` 组装受管只读能力；`:626` 构造查询工具，`:1533` 提供给 Owner。不能从宿主工具可用推断 Owner 已获得权限。
- `packages/dingtalk-dsh-assistant/execution-session.js:128`、`:130` 按节点 allowedTools 限制工具；`task-workflow.js:231` 工程修改节点仅提供 `engineering_repo_inspect`，提示词禁止命令执行。另建工程阶段不是自动获得浏览器的路径。
- `packages/dingtalk-dsh-assistant/agent-query-runtime.js:61` 明确运行镜像与 Git 提交之间尚无映射。现有结果没有被模型遗漏的 PR 映射字段。
- 反证：仓库已有平台查询客户端和独立 headless 浏览器验收脚本，因此“全系统没有能力”过强；准确说法是“当前 Task 没有接入完成此项验收所需的受管查询”。

## 可复用线索与最小下一步

部署证据无需重新实现平台客户端：`workflow-platform-clients.js:105` 的 `github.readPullRequest`、`:155` 的 `readCommit`、`:263` 的 `woodpecker.listPipelines`、`:282` 的 `readBuildEvidence`、`:387` 的 `registry.readManifest` 已存在。`workflow-release-platform.js:119` 与 `:179` 至 `:198` 已核验构建提交、registry manifest 与运行 Pod digest（含多架构摘要）。可评估仅将这些只读路径接到当前 Task 的注册资源、固定 repository/environment 和证据绑定；不得为了查询调用发布、建 Tag、合并等写路径。反向从运行摘要定位构建仍需实际记录支持，不能凭 tag 或 PR 标题猜测。

浏览器可复用 `docs/acceptance/message-clarification-admission/scripts/verify-authorization-browser.mjs:40` 和 `docs/acceptance/topic-context-completeness/scripts/verify-observer-browser.mjs:42` 的独立 headless Edge 启动、页面检查与截图流程；这些目前是开发验收脚本，使用 fixture/拦截 API，不能当作已具备 UAT2 登录和真实页面证据。若后续实施，仅接入受控 UAT2 目标、独立上下文、合法会话和截图产物读取，并保留任务/需求版本证据绑定，不开放任意浏览器或宿主 shell，不接管用户现有浏览器。

本轮用户是在问是否真缺能力及执行会话能否完成；本轮止于上述事实与接入方案，不自行新增浏览器系统、不宣称任务恢复。盲点：未实际查询 PR #363、构建平台或 registry 的当前数据，未启动 UAT2 浏览器，因此不判断修复是否已部署或页面现状。
