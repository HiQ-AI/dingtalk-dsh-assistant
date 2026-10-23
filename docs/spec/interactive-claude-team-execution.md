# 交互Claude团队执行后端

## 目标与基线

用户授权修复DSH PTY生命周期，将交互式Claude Lead带原生Agent Team接入执行后端；统筹继续DSH，配置页只有DSH原生与交互Claude两项，默认DSH。基于2026-10-23 freshly fetched origin/main 63101e8，在worktree-interactive-claude-team实现；已有未提交主检出和旧候选保留。

R26已证明已安装DSH spawnTerminal可启动交互Lead，创建两名原生队友、队友直发核验、lead汇总703、两名shutdown批准及CLI退出0。反证是terminal.pid固定0、释放后宿主MessagePort/PipeWrap持活；这不是完整插件集成。R25 peer请求被工作区规则拒绝，生产任务须通过受管PTY直接输入，不能把peer消息当新用户授权。

## 设计边界

1. 每个DSH execution绑定一个交互Claude Lead；内部队友是该Lead的原生成员，不伪造为独立DSH execution。DSH统筹按实际需求拆执行，Lead按内部任务需要组队，无固定人数下限/上限。
2. 保留executionBackend=dsh/claude-code。新Claude执行固化claudeSessionMode=interactive-team-v1并随binding校验；旧无标记记录不迁移为交互，历史查看/真实排空保留。DSH默认与原生会话协议不变。
3. 复用ctx.subprocess.spawnTerminal，PTY只处理交互收发，不将ANSI屏幕文本作为任务完成证明。通过Claude原生hooks及MCP桥取得结构化身份、工具效果和结果；先用真实探针验证hook覆盖Lead/teammate、认证与权限，再落实实现。不能关闭门禁或复制认证凭据来凑成功。
4. 完成需要当前版本结构化提交、反馈读取、效果账结清、原生队友关闭、Lead退出和DSH进程范围排空。模型自述、任务状态文本或屏幕回显均不替代这些证据。取消与错误保留unknown，不假定外部效果回滚。
5. 原生teamName不能由--session-id推导（R26已出现不同内部leadSessionId）；从真实原生成员metadata和运行事件建立归属。成员本轮执行文档由Host依据事件生成，按inputVersion保留旧轮，不靠模型写文件声明完成。
6. 用户Claude登录/模型来源保留；受管hooks需要隔离用户额外hook/plugin副作用，须在真实配置探针中收敛。不能把-p专用permission-prompt-tool直接套到interactive。

## 宿主与交付

宿主修复拆为DSH subprocess-local生命周期修复及node-pty Windows传输清理补丁。两者构建成固定版本本地tarball，保存原始base、补丁、构建配方及SHA；在独立消费者安装后验证真实PID、自然退出、取消、释放后自然结束。禁止仅验证workspace patched node_modules或直接编辑生产安装。

正式部署沿现有native SIGINT/账本排空/精确PID/双包安装/健康回读流程，加精确PTY两包安装与实际消费者路径校验；不使用写死alpha2的旧全量宿主升级提案、不引入无关依赖升级。不触发手动CI，不发布版本Tag。

## 分工与验证

- 宿主成员：PTY源码、发布闭包、干净消费者与退出/取消反例。
- 后端成员：hooks探针、交互驱动、权限/身份/反馈/结果/取消/逐轮成员文档。
- 配置验收成员：配置及浏览器、默认/持久化/旧执行边界，部署提案与负例。
- 统筹：持久模式绑定、集成真实任务、独立审查、PR/合并/精确包/部署实际功能核验。

R27起逐轮保留执行文档和matrix；修复重跑新增轮，不覆盖R25/R26首错。定向回归、原生后端反例、配置浏览器、真实Claude团队和取消/续办、release smoke、合并回读、部署后包/进程/健康/功能各自记录。任何层未通过不得借其他层通过宣布完整交付。
