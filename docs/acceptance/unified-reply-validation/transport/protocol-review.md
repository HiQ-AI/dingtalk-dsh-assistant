# 个人引用回复的组合内容能力核实

核实日期：2026-10-22，Asia/Shanghai。仅做协议、源码、只读 Schema 和版本调查；没有消息发送、附件上传、凭据提取、安装升级或外部 Issue/PR 写入。

## 结论及实现边界

**已确认：当前 DWS v1.0.63 的个人引用入口没有“原生引用 + 正文 + 多个本地图片/文件附件”的组合参数。上游当前 main 同样没有该组合路径。底层 MCP 是否另有可用的完整组合协议仍未证明，不能宣布钉钉平台整体不支持。**

当前 main 为 `8ad873a59fe1df8f9f6c87cd0a88e86acf3a72a6`，最新正式 Release 为 v1.0.65。该源码已支持普通 Markdown 消息的本地图片上传，但不等于支持个人引用、文档、任意附件同条混排。未发现一个已有升级或开放 PR 能完整满足本需求。

因此本轮保留既有文本通知的发送与恢复合同，先准确记录能力缺口；完整交付对象及其资源身份、持久化和恢复结构须依据真实组合协议再实施，不提前搭建没有可用出口的接口。在拿到协议前，不应编写猜测 `replyMsgType=richText` 等传输，也不能以拆条发送、链接清单、合并转发或更换机器人身份算作完成。

## 已核实事实

| 层级 | 当前事实 | 证据与限制 |
| --- | --- | --- |
| 安装版快捷引用 | `chat +messages-reply` 参数只有正文、来源、身份、幂等等；无 file/attachments 参数。说明称普通个人引用按纯文本解释。 | `transport-evidence.json` 中精确 leaf Schema；其中“纯文本”描述存在下面的客户端渲染反证，不能据此否定所有 Markdown 样式。 |
| 安装版原子引用 | `chat message reply` 同样没有附件参数；其接口绑定 `chat/send_personal_message`。 | 精确 Schema；未用业务 ID 试发。 |
| 上游原子引用实现 | 外层 `msgType=reply`；内层 JSON 为 `referenceOpenMessageId`、`srcMsgSendOpenDingTalkId`、`replyMsgType=text`、`content=<string>`。 | [chat.go:8289](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/8ad873a59fe1df8f9f6c87cd0a88e86acf3a72a6/internal/helpers/chat.go#L8289)。 |
| 上游快捷引用实现 | 同样固定 `replyMsgType=text`，正文字符串包装后发送；没有本地图片处理器和文件资源清单。 | [reply_extensions.go:213](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/8ad873a59fe1df8f9f6c87cd0a88e86acf3a72a6/internal/shortcut/chat/reply_extensions.go#L213)。 |
| 普通本地图文发送 | `send` 的 Markdown 路径调用 `ResolveMarkdownLocalImages`，使用 `CHAT_IMAGE` 上传图片，替换为 mediaId，再发送普通 `msgType=markdown`。 | [chat.go:4312](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/8ad873a59fe1df8f9f6c87cd0a88e86acf3a72a6/internal/helpers/chat.go#L4312)、[chat_markdown_image_upload.go:91](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/8ad873a59fe1df8f9f6c87cd0a88e86acf3a72a6/internal/helpers/chat_markdown_image_upload.go#L91)。它没有证明 quote 内相同内容可用，也不覆盖 PDF/Office 文件。 |
| 文件发送 | 普通 file 分支通过上传得到 dentryId/spaceId，并构造单件 file 消息。 | [chat.go:4185](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/8ad873a59fe1df8f9f6c87cd0a88e86acf3a72a6/internal/helpers/chat.go#L4185)。不能把单件 file 内容塞进 reply 字符串后假定成立。 |
| 旧原始 MCP Schema | 2026-07-13 官方快照只有 `msgType:string`、`content:string`，没有内容联合结构或 replyMsgType 枚举。 | `transport-evidence.json` 保存单工具投影；该 pin 已于 2026-08-03 退役，既不是当前实时契约，也不证明任意字符串类型可用。 |

## 已寻找的反证

- [开放 PR #1450](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/pull/1450) 只修改帮助文案，作者报告当前 `replyMsgType=text` 在桌面客户端仍能显示 Markdown 标题、加粗、代码、列表。没有图片/文件组合场景证据。故本结论基于“无组合参数/实现”，而非“text 必然不渲染任何 Markdown”。
- [已关闭 Issue #497](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/issues/497) 的维护者说明，引用图片/文件的读取投影在 v1.0.57 已修复。它证明读取侧存在富媒体引用处理，不证明 DWS 当前发送侧能生成用户要求的结构。
- 机器人 Markdown 引用有独立实现，但更换发送者身份及未验证的文件混排均不满足本任务；没有采用。
- 上游 OpenAPI 文档搜索与定向公开搜索未找到个人 `send_personal_message` 的完整组合 content 契约。“未找到”只作为调查边界，不能证明协议不存在。

## 当前身份的实时 Schema 获取边界

CLI 确有当前身份内部认证的只读入口 `dws mcp published tools <mcpId>`。它通过 `mcp-meta` 解析市场 MCP 服务，再用当前运行认证和身份请求 `tools/list`，无需手工读取凭据。实现见 [mcp_published_command.go](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/8ad873a59fe1df8f9f6c87cd0a88e86acf3a72a6/internal/app/mcp_published_command.go) 的 `newMCPPublishedToolsCommand`、`resolvePublishedMCPEndpoint`、`resolveMCPPublishedClientConfig`。

但此入口需要已核实的市场 `mcpId`；当前只知道内置 chat 的静态服务路由，不能把 `chat`、路由 hash 或 help 示例 `2480` 当成其市场 ID。root、MCP、API 帮助及源码未发现按内置 productId 读取实时工具 Schema 的公开 CLI 入口。

为寻找真实服务 ID，实跑当前身份的只读 `dws dev mcp service list --keyword 群聊 --page-size 20 --format json`，返回 `upstream_code=no_permission`，原因是当前身份无该组织的开放平台“应用开发”权限。未切换账号、申请权限或调用管理写接口。此失败仅阻塞这条服务目录发现路径，不等于已有 chat 消息权限失效，也不证明市场工具读取一定无权限。

调查中曾对源码公开静态地址做无凭据的 `initialize/tools/list`，得到 `Missing service_id or access_key`。**该匿名结果不构成当前登录身份的授权判断，也不作为组合能力不存在的依据。** 未据此提取凭据继续直连。

当前仍缺：官方 chat 市场 ID，或官方提供的无需暴露凭据的内置产品实时 Schema 入口；更关键的是支持个人引用与图片/任意文件组合的完整内容协议。

## 有依据的后续改动位置

若维护者确认并提供组合协议，DWS 侧应修改 `internal/shortcut/chat/reply_extensions.go` 和 `internal/helpers/chat.go` 两个个人引用入口，并统一复用同一内容构建器；普通图文的 `ResolveMarkdownLocalImages` 可以成为图片资源准备基础。必须先验证文档/附件联合结构，不能只把已知图片实现复制进引用路径就宣布需求完成。

后续必须覆盖一次发送同一 messageId 的正确来源引用、正文、两张图片；正文与 PDF/Office；图片文件混合；同名不同内容、部分上传成功、发送未知后恢复不重放，以及客户端实际显示与读取投影差异。普通文本引用现有行为应保持。真实群消息验证需要明确场景和接收目标，不能在原业务群试探协议。

## 复核方式与证据

最小复核命令：

```powershell
dws version
dws schema --cli-path 'chat +messages-reply' --compact
dws schema --cli-path 'chat message reply' --compact
dws schema --cli-path 'chat +messages-send' --compact
dws schema --cli-path 'mcp published tools' --compact
gh api repos/DingTalk-Real-AI/dingtalk-workspace-cli/commits/main --jq '.sha'
gh api repos/DingTalk-Real-AI/dingtalk-workspace-cli/releases/latest --jq '{tag_name,published_at}'
gh pr view 1450 --repo DingTalk-Real-AI/dingtalk-workspace-cli --json state,headRefOid,body,files
```

`transport-evidence.json` 保存安装版 leaf Schema、原始源码 SHA256 与必要行片段、历史单工具 Schema、当前身份只读失败的脱敏结论、反证来源。完整第三方源码仅用于调查，核实后移除，不纳入本仓库交付。`upstream-protocol-question.md` 是可复核的技术问题草稿，本轮没有对外发送。
