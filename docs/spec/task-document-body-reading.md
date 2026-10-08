# Task 钉钉文档正文读取

## 目标与现状

用户已授权实施。原 Task `task-1edb9931ffe6ecd4efc0a3949376d66f` 已创建，但 Owner 将文档正文与 UAT 一起列为等待条件。当前 `createTaskMessageResourceCapability` 仅支持 fileId/mediaId，`taskMessageResources` 依赖附件材料账，正文中的钉钉文档链接没有进入 Owner 可读材料范围。

可验证目标：原交办链的文档链接由现有只读工具读取，完整正文进入 Task 查询证据；缺少 UAT 不阻止正文核验、需求分析和代码调查。沿用原 Task，不制造新交办或变更原消息。

## 实现路径

1. 在现有 `normalizeResourceRefs` 识别严格的 alidocs.dingtalk.com/i/nodes 链接，以 nodeId 作为 dingtalkDoc 资源身份。协调器和 Task 复用同一解析，不把登录页面当正文。
2. DWS adapter 的现有资源读取方法增加 dingtalkDoc，使用当前 profile 和 runner 执行 `doc +fetch --scope full --detail full`。先核验实际 JSON 契约；不猜字段，不添加公网抓取替代。
3. 旧 Task 的冻结 sourceInstructions 可派生正文链接。派生引用必须与当前 sourceKey、版本、群、发送者、原文一致；不改写历史来源。附件仍使用原材料账规则。
4. 读取前独立回读原消息，确认相同链接和消息身份；读取后保留结构、元数据、正文摘要。现有查询证据系统执行独立验证并落盘。来源变化、不完整、身份不一致明确拒绝。
5. Owner 先尝试可用只读工具，再根据真实失败区分系统/权限/认证/资料问题；UAT 只阻塞依赖环境的工程阶段。恢复使用现有受控 Owner 机制。

## 验证与边界

- 正例：新消息和无附件投影的旧消息；同节点不同query去重；表格/标题完整；查询证据保存；同一Task恢复。
- 反例：伪造域名/URL、任意nodeId、跨群、旧sourceVersion、正文漂移、截断和权限失败均不冒充正文读取成功。
- 针对性测试覆盖 DWS、bridge、coordination、Task scope 与 Owner 规则，部署按现有维护runbook，独立核对包、安装、进程、健康和真实正文证据。
- 不指定用户未提供的UAT，不扩大到本聊天直接开发dataset业务，不创建第二套凭据、材料库或抓取服务。
