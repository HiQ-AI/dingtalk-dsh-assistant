# 数据变更候选证据交接与自主恢复

## 第二根因及方案

原Task r2 stage1冻结输入仅群原文、目标与平台基线；Owner旧r1结构查询没有交给SQL候选，候选返回空SQL，code validate-package等待DATA_CHANGE_PROPOSAL_INVALID。当前冻结v7没有领域修复；Owner原生纯读节点恢复不适用于这个code校验失败。因此属于实现/能力交接缺口，不是用户资料或真人审批前置。

复用现有Task原生查询账传当前Task/revision/scope的引用，平台独立读取原生query-evidence及工件、来源和输出digest后生成既有sources；旧r1不可改装r2。候选提交前调用同一零写stage准备路径验证上下文，缺证明在同会话得到具体纠正反馈，而非接受后永久应用受阻。

显式Host候选修复策略仅允许无任何effect且后续工单/审批/执行节点未开展的准确validate-package失败，保留冻结v7定义、原始失败和Task/Run。Owner读诊断并重新查询，受管changeInput生成新generation重新编写/校验；输入/目标/原文/控制/lease及准入票据应用前再核验。相同来源事实仅换证据ID、重复策略不取得新修复许可，反馈在候选事务前可纠正；未知效果及已有工单不重做。

## 本轮边界

实现及隔离验证正在完成。上轮开始通知已正式生效且唯一，当前业务未建本次工单；本轮完整通过前不宣称自主执行修复完成。不会代真人批准或直接执行生产SQL。

## 定向验证与部署反证

核心恢复20、领域合同19、原生会话25共64项通过；服务授权/查询/原Run恢复8项、受信平台9项、工具schema16项通过。广泛旧消息Agent fixture 7/14失败及旧协调cwd环境失败保留，不声称全仓通过。

正式包 c45a2dbae658df40fda60b9d4fb4fda0029f7c126dc345345932f92e70d6bbbf，Check/安装/Readback/Resume通过，PID40088健康，maintenance=false revision423、dispatchResumed=true、自启启用，原PID49020退出。群有界独立回读仍只有1条开始，未新增内部进度。

实际运行反证FAIL：原Owner自动补查当前结构并读取当前失败及候选，但repair提交附带合法当前query及stage诊断wrapper时，候选/应用合同仍要求全部引用只能为失败诊断。多次TASK_OWNER_RECOVERY_DIAGNOSTICS_UNREAD；尚未建单。保持失败历史，下一轮拆开必读诊断与额外受信证明，校验两层一起修正。
