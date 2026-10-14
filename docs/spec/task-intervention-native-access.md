# 任务引用、人工介入与原生能力

目标：回复正文不重复钉钉原生引用；技术/插件/宿主阻塞在 Web 人工介入或当前 DWS 登录人的私聊处理，需求提出人仅接收必要业务信息问题；原生任务执行不再被插件额外文件边界或跨操作全局锁阻断。

现状与证据：协调模型生成了前置 Markdown 引文，出口仅处理署名；新 task-session 将任何 question 直接 queueReply 到任务原发起群。旧 dws-bridge 的私聊监听及引用恢复仍存在，但其分支只识别旧 humanBlocker/workflow-approval，新 taskSessionRequest 不满足旧任务查询条件。execution-session 虽给动态执行 danger-full-access 并绕过工具白名单，仍安装 guardTaskFileSystem，禁止任务 .dsh 日志及其他任务目录；nativeOperation 与 SQLite operation.start 各自设置任一 unknown 的全局阻断，并给缺少并发元数据的工具分配 host-native-operation 全局锁，导致 gh/pwsh 只读调查无法执行。

方案：提示明确禁止复述被引用原文，格式器仅去除与受信来源一致的前置引用，保留其他引用证据。人工申请按 audience=requester/operator 明确分流，缺省 operator；operator 请求持久保留于现有 Web 面板，私聊沿既有原生通知账及 sendSelfIntent/独立回读，身份取当前登录账号而非任务提出人。现有私聊事件和轮询处理 taskSessionRequest，要求精确通知引用、私聊会话、真实发送者和当前申请版本；群补充不得作为 operator 问题的答复。

去掉动态任务的附加文件拦截、原生调用全局 unknown 门禁及合成全局资源锁，继续沿原生 preset/sandbox/approval 执行；保留原操作身份去重、真实未知记录、任务版本、取消排空与业务完成证据。旧未知结果不会通过本次修改伪装为成功。

验证：重复来源引文与合法引用反例；业务问题、Web-only 技术申请、私聊发送/回读/精确引用恢复、错误作者/群/引用/过期版本拒绝；真实原生 gh 调用及任务日志读取在已有 unknown 时可用，原未知账保持。定向回归、精确包部署及目标任务恢复分别取证。PR #175 已合并，新分支基于最新 main，不向已合并分支推送。
