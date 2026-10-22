# 可配置任务执行后端

用户在团队协作与每轮文档已实现后追加：执行会话支持 DSH 原生和 Claude Code CLI 两种方式，在插件配置页选择，默认 DSH 原生。统筹仍使用现有 DSH Task session；不修改消息归类、协调、3–10 人团队与任务完成责任。

## 当前实现与缺口

- Agent 配置页已有唯一配置表单及 `PUT /config/agent`，运行配置由 `task-resident-runtime.js` 和 `store.js` 管理；扩展现有表单，不新建设置入口。
- `task-session-service.js` 的 run/cancel/feedback/recoverDrained 和十分钟观察直接依赖原生 execution-session；恢复、效果对账和会话跳转也引用原生持久化，不能只在启动处替换进程命令。
- dynamic execution 已持久化 definition、唯一 execution/session 身份、输入版本和租约；continue 保留原 definition。可直接保存后端选择，无需新任务表或数据库迁移。
- 本机 CLI 只读检查为 Claude Code 2.1.212，未登录。官方当前网页包含晚于本机版本的能力，必须结合本机 help 和实际 CLI 输出来验证使用的协议。

## 确定合同

- `agentConfig.executionBackend` 只接受 `dsh`、`claude-code`，缺省 `dsh`；枚举验证通过后才持久化。配置页写明只作用于新建执行；保存失败保留草稿，重新读回使用现有行为。
- 新 dispatch 固化 `definition.executionBackend`。缺字段的既有执行按原本 DSH 身份继续；后续切换配置不能改变旧执行、续办或恢复的后端，也不能通过重建执行替身迁移。
- Claude Code 使用当前用户已安装/已配置的 CLI。无隐式登录、凭据迁移或自动安装；CLI 不存在、未登录和协议错误明确返回技术错误，不静默降级成 DSH。默认执行命令为 PATH 中 `claude`，不新增尚无需要的路径/模型/权限参数。
- DSH 原生实现保持原路径；Claude 后端通过独立适配器承接同一任务输入、阶段报告、结果、成员沟通和每轮文档。独立文件的理由是进程、协议与恢复形态不同，不把 CLI 处理塞进既有原生会话实现。
- CLI 外部效果必须在执行前取得当前身份/版本及原操作账准入，未知效果仍阻塞重放；会话与受管进程真实排空后才释放占位。运行配置不能被解释为对任意外部动作的新增授权，不使用跳过权限校验参数。
- 恢复检查和进度观察按创建时的后端分派，不能用原生句柄缺失证明 CLI 已退出。CLI 实际 session 与 DSH 会话入口区分，界面不提供错误的原生会话跳转。
- 继续复用 `outputs/<executionId>/round-<inputVersion>.md` 的逐轮文件。Claude 报告与内部消息必须进入同一持久账；不另写和原账冲突的执行状态。

## 分工与验收

统筹负责 backend 固化/生命周期路由及交付；运行适配成员负责 CLI 协议/受管进程/内部工具桥接；配置成员负责原表单/持久化/默认值；验收成员独立检查身份、权限、取消恢复与首次失败边界。各成员记录在 `docs/acceptance/task-collaboration-quality/round-7/`，后续轮次另建文档，不覆盖先前记录。

验证至少覆盖：默认 DSH 不变、配置保存和非法值、已有执行不随开关换后端、新 CLI 执行及原 session 续办、3 人协作/反馈真实消费、每轮文档保留、错误/取消/重启无替身和无重复效果、CLI 不可用明确失败、打包可独立启动。协议测试采用真实子进程和固定协议夹具，不能伪称真实 Claude 推理；登录后再进行限定本地文件的 CLI 实测，分别报告证据层。

参考：[Claude Code CLI](https://code.claude.com/docs/en/cli-reference)、[程序化运行](https://code.claude.com/docs/en/headless)、[Hooks](https://code.claude.com/docs/en/hooks)。使用 `--print`、结构化输出和指定 session 续办的支持以本机版本验证为准；适配接口的最终决策与实测限制记录在本轮执行文档和 goal.md，不回改本分析快照。
