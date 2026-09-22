# 第 17 轮：本地部署回读

用户明确授权打包部署本地。候选源码 `60f883cfeae9020c7a9a78fac3a2274c371efb64`，Assistant 0.5.15 本地 tgz 的 SHA256 为 `ef42e996500161631264b4ef672846860fa193d18c6a8608a8cea1b39af3bcfc`。

- 使用原生 profile CLI 安装，仅 Assistant 依赖改到唯一 tgz；Observer 与其他依赖保持原值。
- 停机前确认无活动 Task；两次切换都在仓库外保存稳定 v9 存储及 profile，源/备份摘要一致，读取校验零非法记录、零剥字段。第二次保留第一次启动已写入的新事实，不恢复旧快照。
- 安装后独立比较全部 34 个 JS 文件：无摘要差异。模型/工作区/流程/并发/任务表同步配置逐字段比较无变化，profile patch/settings 摘要保持。
- 新进程 PID 69760，3080/18998 同属此进程。17:16 后健康为 ok，inboundProcessing=true、DWS bridge healthy=true、recoveryIssueCount=0。
- Web 原生 token 握手 303 设置 cookie，携 cookie 访问页面 200 且为 HTML；没有公开 token，不声称完成浏览器交互验收。
- 17:17:55 只读观察：未归类积压已清空；原问题话题已从未派发进入独立决策会话并调用 group_decision_context_get，attempt=0。此时仍未接受决策、未创建关联 Task，不能把恢复派发当业务完成。
- 历史活动审计仍在推进；缺失旧 Session 计为 unavailable，与当前恢复错误分开。真实模型端到端时延和钉钉消息送达未作验收，不发送测试消息、不批量补建任务。

第一次候选启动空转已记录于第 16 轮，修复后重新全量测试与打包。最终实例未启用 Inspector。
