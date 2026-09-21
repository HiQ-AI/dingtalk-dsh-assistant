# 第二轮验收记录

日期：2026-09-21。新增同轮故障：UAT2 基础数据编辑角色菜单组配置任务卡在话题上下文预算。

| 用例 | 结果与证据 |
| --- | --- |
| R07 | PASS。修复分页零字符边界后 `pnpm test`：458 项通过，0 失败。 |
| R08 | PASS。重新打包的 Assistant / Observer 文件分别为 154962 / 19932 字节，SHA256 分别为 `DC95B700A9A3F0E65093E33E648E90CC8998D9F606C9AC612CC2FDF8AA81D356` / `BE02A9C8DC10B78B242A91E96D0F33828B783EB7600C193C961354F1CBA34FBB`，安装目录对应源码哈希均一致。 |
| R09 | PASS。停止旧 Web 进程及其两个专属 DWS 监听子进程，完整存储在仓库外备份且 SHA256 一致；稳定存储只读预检 Domain v8、61 个任务、0 非法记录、0 字段剥离。两包安装后 `runtime.js`、`topic-runtime.js`、Observer `web-client.js` 与源码 SHA256 一致，原 profile patch 哈希未变。新进程监听 3080、18998；`/health` 的入站、出站和 DWS bridge 可用。指定 `method-select` 等待任务更正通知经 Outbox 得到 deliveredMessageId，再用 `dws chat +messages-mget` 对同一 profile 和消息 ID 独立回读：`complete=true`、`foundCount=1`、`failedCount=0`，正文明确“已暂停”。启用的任务表格同步状态为 success；`dws sheet +read` 回读 A1:N23，`complete=true`、`hasMore=false`、无截断。 |
| R10 | PASS。原任务 56 条话题消息只读复现：旧实现 `topic_context_budget_exceeded`；修复后返回 11 条、序列化 11983 字符，低于 12000 字符预算。运行任务第 96 轮等待报告在切换后审阅通过；修复该内部故障并用受管授权接口恢复原任务后，新计划检查点 `plan-v12-after-budget-fix` 获 `guidance`，任务保持运行并进入实际执行。 |
| R11 | PENDING。配置纠正、回读及账号复验尚未从叶子任务取得完成报告。 |

部署健康仍有 1 条 `activity-projection` 告警：2026-09-21 10:59:17 UTC 存储临时文件重命名遇 `EPERM`，同时间主会话与本地只读检查并发。入站、出站和任务执行仍可用；继续观察是否复现，不能写成全绿健康。Web 首页未提供认证凭据，HTTP 401 仅证明入口存在，不作为已认证 UI 验证。
