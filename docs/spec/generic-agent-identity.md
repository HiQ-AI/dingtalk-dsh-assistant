# 通用 Agent 身份边界

生产源码在 message-workflow、workflow-service、workflow-notifications 中直接匹配本机 Agent 和用户姓名，导致换 Agent 后状态问句、旧排查续办授权和签名不能保持一致。runtime 已提供 getAgentConfig().agentNames，身份及别名应从当前运行时配置读取，不新增第二套身份参数。群签名仍由群职责中的明确署名规则提供，不默认任何人名。

复用现有 isExplicitAgentDirection 判断当前 Agent 指向，接入 workflow-service 的准入和 message-workflow 的正常/恢复路径。缺配置时不触发确定性身份捷径，保持模型归类和其他权限规则；改变配置后下一条判断读取新名称，不缓存旧身份。签名提取唯一明确的“代回”署名，未指定则不自动添加，歧义拒绝。历史通知正文保持不可变。

以不同 Agent 名称、别名、正则字符、未配置和改名后的旧名称构造正反例；验证签名不重复、不默认、不越群，以及旧通知恢复不被新职责重写。相关源码回归与全包姓名扫描分别验证；不把个人测试素材的出现误作生产绑定。README 和部署说明改为通用示例。按隔离分支交付 PR，本轮不擅自更改本机 Agent 配置。
