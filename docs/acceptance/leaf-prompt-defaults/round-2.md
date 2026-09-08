# 第二轮：合并部署与真实配置

- PR #81 已 MERGED，main 合并提交 `79cda4dac2e4ada997078424be2cc68d3509d965`，本地 fast-forward 后打包。GitHub 未配置本 PR 检查，`gh pr checks` 返回 no checks reported，不声称 CI 通过。
- 安装 Assistant 0.5.13 本地 tgz，使用新目录 `artifacts/dingtalk-dsh-assistant/79cda4d` 避免同版本缓存；包大小 104050 bytes。profile 仅 Assistant 依赖改变，其余逐字段对比不变。
- 安装后 runtime.js/client.js/web-client.js 与合并 main 独立哈希一致；Runtime SHA256 `D63E29B22FD49B4A36329C29955A703F0AF3407011B2DC0240DC00C04E108DD9`，Web bundle SHA256 `64717112476CD5848B3DF75C0ECB7A0EF9B563ACF6A699784A9FC6EA6F75531A`。
- Web/Runtime 同一 Node 进程 PID 964056，3080/18998 均监听；health=ok，recoveryIssueCount=0，DWS bridge healthy=true、listener=ready、backfill=ok。启动后数十秒及下一轮轮询继续正常。
- 配置变更先备份并执行 `--check`：与上一轮 620 字通用文本及其余配置完全一致后，仅 PUT `{leafSessionPrompt:""}`。GET 独立回读与备份仅此字段不同；九项流程、revision、taskPromptsVersion=1 及模型等设置不变。v7 实际存储文件独立读取：补充长度 0，流程 9，版本 1。
- 部署前独立 Playwright 认证页读到输入框 620 字、details=0。部署后日志没有提供新登录 URL，未据此推断页面失败；改用独立受控 Chrome 标签已有认证打开真实页面，看到内置说明、空补充区、九个 collapsed 流程，保存按钮 disabled。与第一轮隔离浏览器中的键盘/编辑验证共同覆盖交互。

本轮仅配置与界面变更，不触发新的群聊业务任务，不声称真实模型完整执行了某个业务流程。新增内置规范的恢复与组合机制由第一轮 Runtime 测试验证。本轮不重复运行未变化的测试；矩阵 NOT_RUN 表示该轮未重跑，最终状态取该用例最近一次执行结果。
