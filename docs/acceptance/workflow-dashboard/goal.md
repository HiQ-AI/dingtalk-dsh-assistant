# 工作流与配置变量管理

> 状态：ACTIVE
> Goal ID：workflow-dashboard-20261013
> 最近维护：2026-10-13T12:38:00+08:00
> 权威目标：D:/codex/worktrees/workflow-dashboard/dingtalk-dsh-assistant/docs/acceptance/workflow-dashboard/goal.md

## 总目标

在运行看板提供工作流目录与独立「配置」Tab。普通变量和凭据统一管理，工作流通过受控引用读取持久化变量，减少对可移动外部配置文件的依赖；版本、权限与敏感信息边界可靠，并完成源码、接口、真实浏览器及文件移动反例验证后以 PR 交付。

## 完成条件

- 工作流目录可查看定义、可用状态、节点、维护依赖、相关任务，任务返回恢复选择。
- 独立配置页支持普通变量与凭据的创建、修改和管理，凭据不在列表/读回/日志/执行账/模型上下文泄露。
- 工作流存在真正消费变量的生产路径，必要配置缺失失败关闭；移动原配置文件不影响已纳入托管的配置读取。
- 更新变量的生效时机和运行中任务的版本边界明确并有测试，不把配置变化悄悄施加到旧任务。
- 定向测试、构建、接口与浏览器矩阵通过，文档同步，PR 真实状态独立回读；不把夹具验证冒充本地部署或业务写入成功。

## 范围与约束

- 基于 origin/main 44646d2，独立分支 worktree-workflow-dashboard；保留主仓用户脏文件，不自动合并或部署。
- Windows 11、PowerShell 7、Node 24、pnpm workspace。复用现有 store/API/权限/host adapter；不新增冗余配置文件层。
- 用户已明确普通配置与凭据一起纳入，并要求独立配置 Tab。不要读取或回显真实秘密；隔离 fixture 验证不触发真实外部动作。
- 非源码产物放 docs 子目录，设计约定维护 docs/manual/observer-design.md；不新建根 DESIGN/UX 文档。

## sub goal matrix

| ID | 子目标 | 完成判据 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| SG1 | 工作流目录与任务导航 | 列表/详情/内置流程/关联任务与返回、状态矩阵通过 | 已验证 | 最终 round-14 目录 32 项通过，源码 SHA 与 round-13/14 记录一致 |
| SG2 | 变量与凭据架构 | 当前文件依赖、存储、认证、secret 和版本合同收敛并落 spec | 完成 | docs/spec/workflow-managed-configuration.md |
| SG3 | 持久化与受控 API | CRUD/CAS/脱敏/授权/重启保持通过 | 已验证 | backend 定向 67/67；最终 UI/API/startup 联合 122/122；native Resident HTTP 重启与多实例隔离通过 |
| SG4 | 真实工作流消费 | 受控引用、版本绑定、文件移动反例通过 | 进行中 | 原生工程 v26 查询、文件移动、Host 重启、新旧 Run 版本及租约反例通过；补齐 reset 新 Run 冻结路径 |
| SG5 | 独立配置 Tab | 普通变量/凭据表单与工作流关联可用，失败/冲突/窄屏通过 | 已验证 | 最终 browser round-13 配置 16 项、round-14 目录 32 项通过；observer SHA 8789fe453f32795ed9ce8849faeb2d5bcec80653b1f3d8be69b56b51059e059f |
| SG6 | 验收与 PR | 全部必要矩阵通过，文档及 PR 独立回查 | 进行中 | 最终 UI/API/startup 122/122；打包与 PR 待进行 |

## 当前检查点

- 当前子目标：SG4
- 唯一下一步：保存 reset 修复后的验证检查点，合入最新 origin/main f1487e0，复测冲突与发行字节相关路径，再打包和 PR 交付。
- 未闭环项：主线合并及针对性回归、全功能汇总与最终打包未完成；尚未提交 PR。

## 进展

- 2026-10-13：新增工作流 Tab 及只读目录、任务跳转返回；设置页重复目录移除，原目录元数据请求仍用于旧配置判定。83 项定向测试初跑 82 通过，导航断言随入口变更调整并新增绑定反例后 84/84 通过。浏览器基线实跑六导航；round-1 揭示 builtInWorkflows 遗漏，保留失败证据。
- 2026-10-13：用户要求增加普通配置和凭据统一管理，再补充独立「配置」Tab；范围进入 SG2–SG5。
- 2026-10-13：原生工程查询增强轮通过；真实 AgentLoop/工具注册/原生会话证据读取，以及源文件移动、Host 重启和新旧 Run 版本分别验证。工程 registry 45/45、控制器/账本定向 248/248、最终 UI/API/startup 122/122。独立审查发现 reset 直接建 Run 绕过冻结，追加同因修复与预检/重放反例，尚不宣布全绿。
- 2026-10-13：fetch 发现主线已合入导航持久化、任务会话关联、移除任务表格同步、UAT 源码上传及工程合同发行字节修复，目标主线更新为 f1487e0。保留既有验收历史，集成后按实际影响复测；旧 446 基线依赖本机 CRLF 合同字节，不能把其摘要直接视为最新发行版本的摘要。

## 重大决策

- 工作流定义与具体执行分开；工程节点随任务/仓库冻结，目录不造静态节点。
- 设置页仍需目录元数据中的 engine/groupIds，保留轻量请求而不替换为包含完整运行态的重接口。
- 配置 Tab 统一维护变量，工作流详情展示引用并跳转对应配置；secret 只提供设置状态，消费受工作流权限约束，版本生效合同必须明确。
- 普通值与秘密统一保存在宿主原生 grant record，以单记录 CAS 发布；默认本地 provider 为明文 YAML，不声称加密。快照在 instanceId 命名空间内仅从 runId 导出，同一运行不能借换 workflowId 重冻结。
- 已有外部文件消费者需要显式改为 Host reader 才脱离文件。本轮提供通用执行能力及受信 DB connector 适配；不自动迁移真实凭据、kubeconfig 或无 runId 的消息查询。
- 交付审查发现仅 code reader/connector API 尚无默认流程消费点，故增加 directQueries.configurationConnections 受信映射：现有 task-node 只读查询工具沿真实 Run/租约读取托管配置。无快照的消息/Owner 访问所映射资源失败关闭；其他文件资源保留原路径。先落增量 spec 再实现。
- 继续查现有工程定义的 allowedTools 发现没有数据库工具，Host 适配仍不足。最终采用新工程 v26 显式接入已登记 DB 只读工具及 Host queryScope；v25 和历史定义保持，不复活退休调查流程，无数据库配置时不授予新工具。变量内容仍不进入模型，原资源/表列/只读约束不变。
- v26 新工具仅适用于显式 configurationConnections 映射且原 permissions 已授权的资源，节点 scope/目录同步收窄；旧文件配置不额外获得工程查询入口。
- 宿主默认凭据文件跨 profile 共享，配置与快照必须按受信 workflow.instanceId 命名空间隔离。同实例内快照只按 runId 寻址；跨实例相同 runId 不共用变量或快照，无历史全局 key 兼容路径。

## 重要信息

- create_worktree 已完成签出，但应用在 ignored AGENTS.override.md 的只读 ls-files 扫描耗时异常。只停止本次扫描后工具报失败，复用 Git 独立回读的已签出工作树并建立分支，没有重复创建或动主仓。
- Playwright 包：C:/Users/64554/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright；独立 Edge headless 已实测。完整 React + observer 源码、API fixture 不等同正式 DSH 部署。
- 当前协作：settings_docs 完成 store/HTTP/secret 并独立审查；review_workflow_ui 收尾 Host 消费及 reset/版本测试；workflow_entry_review 已验证最终浏览器 round-13/14，等待源码冻结后复跑历史定义恢复。
