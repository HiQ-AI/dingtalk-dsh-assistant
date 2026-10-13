# 第 6 轮：原生策略恢复及部署门禁拒绝

2026-10-13，Windows11 / PowerShell7.6 / Node24.19.0。

- 正式原生 `hoisted / autoInstallPeers=false` 策略的冷候选通过。32个core直接依赖闭包（27个DSH、5个Cordis）与5个插件、yaml组成38直接依赖，来源manifest、声明及摘要核验；未切换安装策略。
- 薄offline续接真实Check通过117冻结输入、零写；同原seal/revision772、业务控制快照不变，执行原生pnpm安装，固定计划任务启动PID39344，双端口同PID。初次缺group的停机故障已修复。
- 启动约50秒后patch由ffadc变248163，保留原注释且追加欢迎/模型/权限/主题设置。原Readback依法拒绝摘要变化。用户说明“另一个会话应该操作过”；写者未证明、原完整prefix未恢复，不声称只有格式变化，不回写旧配置覆盖并行工作。
- 初次只读浏览器策略阻断native POST读取RPC、首页空会话初始化和欢迎弹层，因此验收不能通过；这些是探针权限和产品初始化限制，不能宣称产品React崩溃。后续按源码精确列读请求，并单独记录必要setup。
- 新采用目录仅写证据，保留旧launch/proof/control。旧PS采用Verify因ISO自动DateTime与字符串比较误拒绝；独立UTC ticks相等，原源码未改。新的只读Node验证器保留JSON字符串并重新核验完整链、现场预设及包，不减弱实例身份判断。
- 旧Web验收要求303 Location字面`/`，新版实际为`./`。真实cookie+页面200、认证headless通过，故应按原生URL语义校验同源根目标；不得伪造响应或跳过认证。修复及最终恢复记录见round-7。

本机完整原始证据在docs/tmp的unified-production-recovery、unified-production-adoption、native-readback-check及UI分轮文件中；配置、会话和认证内容不提交。
