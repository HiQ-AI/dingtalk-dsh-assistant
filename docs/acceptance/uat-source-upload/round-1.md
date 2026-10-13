# Round 1：实现与独立复审

源码归档上传测试 11/11；平台客户端、Host、release、UAT 来源与重建证明、源码消费测试合计 73/73。真实 Git fixture 覆盖浅 fetch、archive、64 MiB 上限及清理；HTTP 使用替身，未执行远端 PUT。

新来源校验 helper 只读实跑历史 dataset repo1/#273、dataset-web repo2/#329。两者均 manual，包含三个来源变量，prepare 成功、clone 不出现；消费日志中的提交前缀和包 SHA256 与流水线变量一致。凭据和完整 variables 未保存。

独立复审额外复现两项失败，不能由前述测试通过替代：

- 缺上传 Token 时实际写请求为 0，但旧交付层将普通异常转成 `ADAPTER_EXECUTION_UNKNOWN`；无流水线时恢复只能反复 unknown。
- prepare 失败且 buildkit 跳过时，新来源校验先抛 `WOODPECKER_SOURCE_PREPARATION_UNCONFIRMED`，旧重建的基线回退只接纳 `WOODPECKER_BUILD_*`，导致重建受阻。

两项修复与回归进入 round 2；原失败保留。复审还要求生产原生 Tag 携带源码变量时沿原构建证明链，不能强加 UAT manual 条件。
