# 允许范围内仓库路径不存在的工具纠正

## 已观察问题与最小边界

模型猜测 `src/components/ReviewDimensionPanel.vue`，实际文件在 `src/views/review/components/`。旧 Inspector 将允许前缀内的快照缺失与越界统一抛出 `ENGINEERING_READ_PATH_INVALID`；原生工具生成 isError 后，会话的既有失败门禁停止所有后续/排队工具，模型没有机会 list/search 自纠正。

只在 Inspector 完成任务身份、当前代、受管工作区/候选与 allowedPrefixes 验证后，允许前缀内且受信文件快照没有该路径的 read 返回正常结构化结果 `{status:'not_found',code:'ENGINEERING_READ_NOT_FOUND',path,source,message,suggestedCall}`。提示按 basename 调用 list，随后读取实际路径。它不提供 expectedHash，也不声明读取成功。正常 read 返回格式保持不变。

不改变 execution-session 的 isError→halt 规则，也不捕获任意 ENOENT 或工具异常。非法参数、越界、身份/代际漂移、权限、链接/候选完整性错误继续抛出并停止会话。未知路径不会被读取，更不会成为任意路径访问入口。read 的空/绝对/重复分隔路径继续按非法参数拒绝。

## 验证

真实 DSH AgentLoop、ToolRuntime 和持久 JSONL（仅 LlmAdapter 为脚本）：同会话错误路径→同批queued合法读取→list→正确读取→submit；五类安全/权限/身份错误仍halt且queued读取零执行。真实registry工作区fixture核对缺失结果、后续合法read、越界和身份负例。当前业务源码、数据库、远端及活动后端进程不修改；需安全窗口重新部署Host后才应用。
