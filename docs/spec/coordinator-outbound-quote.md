# 群协调器外发引用识别

## 目标和现场基线

修复群消息引用已送达机器人回复时，协调器反复领取却始终不能提交的问题。恢复沿原消息、原来源版本和原协调会话进行，不手工修改消息账，不重复发送历史通知。

2026-10-13 只读控制账与原生会话交叉核验：同一批两条来源的版本没有变化，连续 claim/bound/release 的 session、turn、lease 一致，但提交持续返回来源失效。被引用来源已是 `superseded/outbound_echo`，同时存在同群、同 messageId 且 evidence 匹配的 delivered 通知。现场私有证据保留在 `docs/tmp/group-reply-missing-20261013/`，不提交业务正文。

## 因果链与范围

`workflow-service.js` 的 `localQuote` 优先读取 `task.source`，将已排除的机器人回声投影为 `sourceKind=message`，遮住已有的正式外发通知分支。协调器将该引用加入 `historySourceVersions`；提交事务正确拒绝 superseded 来源，重领后又产生同一错误引用。

先以精确的已投递通知证据解析机器人引用，再处理正常入站引用；保持普通来源版本校验、租约校验与事务门禁。检查同类 superseded 引用，不能把无效入站伪装成当前有效来源，也不依靠忽略 stale、手写状态或新建会话恢复。

## 验证与部署

复用工作流服务测试 fixture，先复现外发 echo 与正常新消息同批受阻，再验证通知精确匹配、普通引用和真实版本变动反例。运行相关服务、协调器与消息账测试，保存结果。

沿现有本地部署 runbook 先进入维护、排空、Check，再安装 Assistant 包；无需 schema 迁移。独立核验包摘要、新 PID、健康与恢复派发。最后回读原两条来源的 commit、处理结果以及新通知的送达证据，服务健康不能替代群消息恢复。
