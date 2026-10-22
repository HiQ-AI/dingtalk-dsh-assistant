# 个人引用回复组合正文与多附件的协议问题草稿

状态：仅本地准备，未提交 Issue、PR 或发送给任何人。

## 需要解决的用户场景

以当前个人身份在原群引用指定原消息，在**同一条回复、同一个 messageId** 中展示结果正文与本次全部产物，覆盖两张本地 PNG/JPEG、PDF/Office 文档以及图片和文件混合。既有发送者身份、原生引用、附件可下载性都要保留。顺序发送多条、链接清单、合并转发或改用机器人身份不等价。

## 当前可复核事实

- 安装版 DWS v1.0.63 的 `chat +messages-reply`、`chat message reply` 没有附件参数。
- 当前 main `8ad873a59fe1df8f9f6c87cd0a88e86acf3a72a6` 的 `internal/helpers/chat.go:8289` 与 `internal/shortcut/chat/reply_extensions.go:213` 仍序列化 `replyMsgType=text` 和正文字符串。
- main 的普通 Markdown 发送已有 `ResolveMarkdownLocalImages` / `CHAT_IMAGE` 上传路径；单文件发送已有 dentryId/spaceId 路径。未找到将这些资源共同绑定到个人引用消息的公开协议。
- #1450 报告 `text` 引用的部分 Markdown 样式可在客户端渲染，因此这里不主张 text 类型绝不渲染 Markdown；所缺的是本地多图及任意文件同条引用的协议与证据。
- 旧 MCP 快照仅有 msgType/content 字符串字段，没有具体联合结构，不能安全推断可接受内容。

## 请确认的最小信息

1. 当前 `send_personal_message` 是否支持上述完整组合？支持的外层 msgType、内层 replyMsgType 及 content JSON 完整字段结构分别是什么？请提供正文、两图、文档、混合四种最小示例，使用占位 ID 即可。
2. 若图片使用 mediaId、文件使用 dentryId/spaceId，如何在同条回复中声明顺序、名称、MIME、大小与资源绑定？支持多少件、总大小及文字长度上限是多少？部分上传成功但发送失败如何识别和恢复？
3. 保持 uuid 幂等时，提交返回的是 openTaskId 还是最终 messageId？如何读回同条消息的引用来源及所有原始资源，避免把被引用消息的资源误认成本次附件？
4. 若只能支持正文加图片，或只能引用单件文件，请分别明确已支持、未支持场景，避免将局部支持作为完整满足。
5. 内置 chat 服务对应的官方市场 mcpId 是什么？能否通过 `dws mcp published tools <mcpId>` 直接以当前登录身份获取实时 Schema，或提供按内置 productId 获取 Schema 的只读 CLI 入口？不需要提供任何 key/token。

## 合入前验收边界

需要发送侧结构测试、真实授权目标的客户端呈现检查、同 messageId 引用与全部资源回读、逐件文件内容核对，以及超时未知不重复发送的恢复验证。只通过 mock、普通图文发送或仅看到 openTaskId，不视为完整验收通过。
