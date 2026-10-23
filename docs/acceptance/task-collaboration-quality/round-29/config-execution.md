# R29 最终 adapter 封板复验

本轮职责：跟随最终后端移除不参与授权/完成判断的 SubagentStart/SubagentStop 订阅，以及新增历史 start mode 防暗恢复门禁，保留原 46 个用例再补 2 个历史身份负例。不修改后端源码，不操作真实 Claude、安装或部署。

- 启动参数断言不含 SubagentStart/SubagentStop，保留 PreToolUse 和 TeammateIdle。
- 并发 race 使用成员真实 PreToolUse 在原生 Agent Post 前到达，验证只等待已准入 spawn 的真实身份，获得允许后写入成员执行文档。
- 历史 start 缺 binding.claudeSessionMode 或 data.sessionMode 时，readProgress 仍读取历史；即使当前 binding 加了 interactive-team-v1，也不能 resume、新起替身或改写历史字节。
- 原权限、反馈、效果、取消、unknown、排空、成员身份与消息路由负例全部保留，不扩大验证范围。

本轮为管道适配 PTY 接口的真实 DSH 受管子进程 + HTTP hooks/MCP 协议验证；真实 PTY/Claude 团队及正式部署由独立主链路验证。
最终完整执行：48/48 PASS、0 skipped、0 cancelled，测试宿主自然退出 0。adapter-tests.log 独立回读通过；源码摘要记录于 config-final-proof.json，adapter SHA 为 fef786be61417bcaf2f6d42134bd5a30a80efdd284649e3a5a26da87fc0cc415，与统筹指定最终版一致。R29 测试职责封板。
