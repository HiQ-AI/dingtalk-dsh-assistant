# 第7轮统筹执行记录

## 职责与当前目标

在原隔离分支和 PR #248 上接入双执行后端，默认保持 DSH。统筹负责服务生命周期路由、创建定义固化、持久账语义、各成员结果集成、相关回归与 PR 回读；运行适配、配置页面和独立验收分别由三个执行成员负责，具体证据见同目录各自执行文档。

用户明确 Claude Code 之后再登录。本轮完成代码及离线验证，不等待登录，不声称真实账号模型或实际部署通过。

## 已落地的服务合同

- 新 dispatch 从现有 Agent 配置读取后端并固化到 definition；缺字段的历史执行始终按 DSH 读取。continue 保留原 definition，因此切换配置只影响新成员；重试同一个派发键先读取原收据，不产生重复成员或定义冲突。
- 按 executionId 的持久定义分派 run、feedback、cancel、assertDrained、recoverDrained。CLI 的 sessionBound 只表示自身绑定，不能注册/附加到 DSH 会话目录；进度、日志路径和 UI 后端字段独立路由。
- 使用同一阶段报告、结果账和逐 inputVersion 执行文档。文档显示实际后端，继续保留旧轮；CLI ACK 记为 cliInputAdmittedAt/claude-cli-input-admission，不伪称 DSH modelStepEnteredAt。
- CLI provider 错误不套用 DSH turn/end 自动重试证明；unknown 效果保留原记录与原始调查材料，不能进入只适用于 DSH 的自动对账或操作员原生失败证明流程。本版不扩建 CLI 效果结清协议，不静默改派或重放。

## 决策与反例

CLI 仅解析 stdout 无法在效果前核对当前身份；旧版本 hooks 的执行失败可能放行，因此均排除。运行适配成员用本机真实 CLI 和回环合成模型确认 permission MCP 的前置门禁；精确启用工具、禁用额外 MCP/hooks、强制 ask 并关闭 Bash sandbox 自动允许。该离线证据只证明对应协议，不代表真实模型任务完成。

独立验收提出：stdin echo ACK 可能先于旧模型结果，单靠 ACK 数不能阻止过时 submit。运行适配成员需加入可核验的反馈读取/提交边界，不能仅改消费字段名称。最终实现与反例结果由 CLI 和验收文档记录。

## 当前验证

- Store 新增定向用例 PASS：非法后端零派发；缺省、DSH、CLI 三种初始定义经续办和重启保持；CLI反馈不产生原生模型准入时间。首次测试夹具显式传 undefined 被 JSON canonical 合同拒绝，改为真正省略字段后通过，生产路径没有改成接受 undefined。
- Store 实跑为 103 PASS、0 FAIL、0 SKIP。原命令还带了不存在的 `test/execution-document.test.js`，输出只有 Store 用例，不能当作另一个文件已测；文档路径另由下列真实存在的测试覆盖。
- `backend-routing-1.log`：真实服务 + SQLite 混合团队路由 1 PASS；验证默认 DSH、切换后新建 CLI、原 CLI 身份续办、旧轮字节、重启不重放及无错误原生注册。
- `backend-documents-1.log`：首轮发现文案统一改为 CLI 输入会破坏原 DSH 消费含义；改成按持久后端显示，未削弱原断言。`backend-documents-2.log` 的 session-workspaces/model-context/task-archive-scheduling 共 29 PASS、0 SKIP。
- `backend-service-regression-1.log`：15 PASS、1 FAIL。9 项 provider 恢复、3 项阶段、HTTP 与混合团队均通过；唯一失败是既有归档夹具只截取多行 Proxy 的首行。修为完整代码边界后，归档两项已在前述 29 项中通过，未修改归档生产逻辑。
- `backend-test-contracts-1.log`：12 PASS；历史测试分类、固定 hash 及删除守恒未修改。`backend-suite-map-2.log`：正式更新并核对 301 文件、3 历史入口、0 删除。
- `backend-release-smoke-1.log`：13 PASS、1 FAIL，失败为新增独立测试后映射需要再次生成；真实提取包任务和 resident 健康检查通过。最终候选冻结后更新映射，另跑 smoke 并保留新日志，不覆盖首错。

## 最终候选及验收交接

CLI 独立验收发现并修复 stdout/MCP 顺序、旧反馈 ACK 放行、取消竞态以及 drain 不足时权限桥泄漏等边界。最终生产适配器 SHA256 为 `1cb9e0123657080f99b73732115b666072bedb34c9b5b9c08d73589d9ff82a77`；独立完整协议集成 26 PASS、0 SKIP，前后摘要一致。固定官方禁后台环境开关，结构化后台回执仍拒绝成功并保留 unknown。

真实 Claude Code 2.1.212 使用回环合成模型、真实 Host subprocess 和生产 Store 的最终两轮通过，第一轮受控 Write/Read/progress/team/submit，第二轮原 UUID resume；只有一条 Write 操作，无重放。独立成员核对 journal、SQLite、文件及两轮文档；该探针未在切轮前记录旧文档 SHA，旧轮不变的全过程证明来自混合团队测试及 SG6，不能混用证据。

配置/UI 成员交付默认及保存/刷新/失败草稿/键盘/390px/CLI 路径与原生导航区分的真实 Chrome 证据；最后仅精确修正帮助文案并重建 bundle，官方 registry 3 项再验通过。三个执行成员分别维护 cli-execution.md、config-execution.md、acceptance-execution.md；统筹按文档读取，针对发现的缺口才查原始材料。子目标仍为 SG7；验收 R7 记录首错，R8 记录最终冻结后的复验，不重建成员。

本文件仅更新本轮进展，后续轮次另建，不覆盖 round-1 至 round-6。
