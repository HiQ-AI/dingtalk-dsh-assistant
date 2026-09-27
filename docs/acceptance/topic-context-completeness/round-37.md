# 第37轮：入站监听恢复与交付收口

当前health degraded/inboundProcessing false、recoveryIssueCount0；群与私信监听均exit5，历史补读exit1。运行profile与CLI报错账号一致；dws event status明确返回旧登录态无法由当前认证服务刷新、authCode.notFound、要求auth login。已为原profile发起一次浏览器授权，未清除账号、未换身份、未发送消息。此时连接未恢复，不声称收到消息。

原PR125仍OPEN，分支worktree-topic-context-completeness，153个工作区条目。代码、脚本及证据需按范围与敏感数据审查后选择性提交，不整体git add。授权等待期间开展只读交付审查。

授权登录在5分钟后超时（CLI exit2），没有重新发起或清除账号；需本人方便时重新扫码。监听恢复/真实新消息接收仍未验证。

交付范围已按独立审查的121文件白名单暂存，docs/tmp全部排除。核心组合206项205通过、1失败：extraSource候选漂移预期CANDIDATE_MISMATCH，实际COMMAND_DRAIN_UNCONFIRMED；安全门禁仍阻断。独立用例多次通过，根因未收敛，不把重跑通过当作产品缺陷已修复。仅补充失败诊断信息，未放宽门禁。补充组合90/90通过，原10文件组合重跑中。原失败日志保留。

组合复跑及同时隔离文件回归进一步出现候选漂移、结果不符、清理失败和取消清理场景的进程回读失败。根因尚未收敛；已委托专项诊断，保持所有产品拒绝门禁。不得把单例PASS视为整体已修复，不commit/push为完成。

根因已由只读进程元数据复现：短命Node PID6564本次出生/退出18:12:59，旧按ParentProcessId递归的逻辑把CreationDate10:21:21的powershell4940及conhost9040判为其后代。两者早于本次Node约8小时，属于父PID复用污染。probe原始证据与脚本保留；后续按进程创建时间限定生命周期，新增确定性反例并进入round38。
