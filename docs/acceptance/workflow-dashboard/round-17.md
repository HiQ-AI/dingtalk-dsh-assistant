# Round 17：合并前运行链收敛

源码检查点 `7d40832` 前的实跑记录已收敛，最终交付采用合入主线后的 round-25；本轮计数存在重叠，不能累计成独立用例总数。

- Controller/store/reset 248/248；工程 registry 45/45；重发专项修复后 1/1。
- 原生生产消费增强第七次 1/1：真实节点工具调用、会话证据与工件读取、原 JSON 移动后旧 Run 恢复/新 Run 新值、Owner 和失效租约拒绝、无托管映射或无权限时不登记新工具。
- reset + connector 最小重验 18/18：完整预检在冻结前、回执重放不再冻结，未映射旧文件保持原 pg 默认参数语义。
- 同一 446 基线记录的 v25 定义恢复摘要一致，v26 三种登记/恢复场景通过。该旧基线依赖当时本机合同字节；主线发行字节变化的验证另见 [historical-definition-verification.md](historical-definition-verification.md)。

完整命令、耗时、失败保留和证据层边界见 [runtime-verification.md](runtime-verification.md) 与 [backend-verification.md](backend-verification.md)。
