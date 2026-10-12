# 当前工程执行与四任务维护迁移

新工程流程使用 task-engineering v22：准备、技术思路、开发、构建测试、本地验收、Git 与草稿 PR。技术思路只要求 document.markdown；可选 scopePaths 仍必须属于已授权仓库范围。模型开发结果的 planRef/effectRefs 由 Host 绑定当前节点，实际编辑效果、候选与交付身份仍由 Host 校验。额外说明字段不构成失败。

阶段可使用已配置且已授权的其它仓库，不要求 dependencyRepositories 白名单。新阶段使用已配置本地验收能力，无须为相同 runner 再注册每个阶段的输入摘要。旧流程定义保持冻结。成功交付的分支、提交和草稿 PR 必须复用；未知提交/发布状态仍要求真实回读。

数据库资源可显式配置 dataAccess: all-tables-readonly。只允许结构化 SELECT；表和列以当前目录为准，账户权限、只读事务、超时与行数限制仍生效。该设置不会赋予数据库账户缺少的权限。

POST /runtime/execution-purge 是本次四任务迁移的闭合维护入口，只接受执行器中列明的四个 taskId、各自 expectedControlRevision、requestId、reason 与可选 checkOnly。要求本地来源、已配置用户访问权限及 active/drained 维护状态。checkOnly 先回读精确数据库归属、保留需求、受保护代码目录及待删除路径，不写执行数据。

正式清理删除当前和历史执行记录、Owner 执行历史及任务内临时执行文件，不创建备份。原始群消息、业务需求及需求引用材料、ws-* 开发工作区、未提交代码保留；真实 commit/push/PR 只保存防重复交付所需的最小映射。外部任务仅引用这四个 ID 的事件、回执和通知不属于清理范围。文件清理未完成前不能解除维护。重试同 requestId 也重新检查 active/drained，不凭旧回执绕过现场状态。

本次现场迁移按顺序执行：候选包自测与独立窄审；正式 scripts/deploy-local.ps1 安装并回读包/进程/健康；正式 purge 的 checkOnly 与执行；独立回读四任务无旧执行历史且仍暂停；仅启动一个新流程。安装成功不代表真实 UI 或钉钉交付成功。隔离 PR 适配器测试也不代表真实 GitHub 发布。
清理后的 SG20 可通过 POST /tasks/:id/prepare-purged-run 接回现有 prepare/plan 入口。限定原授权四任务中用户当前选定的一项，在全局维护排空且四任务文件清理完成后，以保留需求创建 v22 Run 并保持暂停；同 requestId 重试复用同一 Run。使用实际返回的 controlRevision 建立现有 task-run 维护范围，再仅恢复该选定任务，不释放全局派发。

持有维护重启后的再次安装使用正式部署入口 HoldMaintenance/ContinueMaintenanceId。原 stopping 封印若属于旧进程，仅在维护 ID/版本匹配、当前 PID/进程 incarnation 对应、排空且四类 busy 均为零时生成独立当前进程停止证据；仍检查 CIM CreationDate 和完整控制快照，不改写旧封印或 Host stopPermitted。

v22 在验收规划尚未成功、全部后续节点未执行且无效果时，也可复用原 checkpoint 更正已配置的验收能力。同一 prepare-purged-run 请求复用原 Run；只在全局维护排空后检测已配置能力是否变化。实际更正重做 define-local-acceptance 和规划，保留成功准备前缀，不修改旧回执。已有外部或编辑效果仍拒绝。v22 冻结定义不因 profile 增加辅助验收注册改变历史摘要。
v22 验收 checkpoint 沿正式注册谱系保留原始交付配置身份，并只在不使用本地 runner 的节点上保留原验收摘要；真实验收节点及交付验收检查仍绑定更新后的能力。成功前缀继续由契约和输入谱系证明，不以整份辅助配置变化重新执行准备。
taskLocalAcceptance 的注册条目可附 checks，用于相同任务需求的真实定向测试及构建；既有配置刷新通过 checks checkpoint 保留已开发候选并重验，不改变仓库默认检查。验证摘要只传播到实际验证与交付节点，无关准备和开发前缀保留原谱系契约。
