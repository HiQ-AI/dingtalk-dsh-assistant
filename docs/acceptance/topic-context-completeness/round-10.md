# 第十轮：移除技术详情与精简响应

用户要求不再展示技术详情，避免影响加载。此前折叠状态仍会对全部输入输出 JSON.stringify 并创建 pre；trace 响应同时传输原始模型输入输出。

将原前端业务结论投影迁到 workflow-service，trace 仅返回 summary、步骤状态/耗时、同批来源等必要展示字段；移除 input/output/usage/evidenceRefs/deterministic。前端移除所有消息技术详情和原始 JSON 节点。原文证据接口保留内部原始记录读取和范围校验，不使用展示摘要代替证据。

- 定向组合：observer-client、workflow-service、http 共 104 项通过，0 失败、0 跳过，23.94 秒。
- 浏览器：19 项通过，17 次只读请求、0 写入、0 页面错误；消息过程区域无 details/pre，结论、耗时、同批来源切换、窄屏和分页保留。
- 部署前同一真实消息的 trace 响应为 46141 字节；部署后同样本测量见后续记录。体积比较不等同于页面延迟的严格基准。
- 未删除持久执行记录，未重放真实消息或业务动作。

## 本地回读

同一条真实消息、同一 trace 接口：响应从 46141 字节降至 5869 字节（减少 87.3%），5 个步骤均含业务摘要，响应无 input/output。83 个 JS/patch 文件与源码 SHA256 全部一致；新 PID 44316 同时监听 3080/18998，health=ok、入站正常、恢复问题 0、DWS healthy=true。此次无 schema 迁移，停机备份在 D:/dsh_home/backups/trace-lite-20260926-8a40977。
