# 第 38 轮进程身份修复

## 根因与反例

原 round-37-core-regression.log 以及 round-37-local-acceptance-isolated.log 失败保留。原问题不是已证实的时限不足：受控短命 Node 进程第 20 次复现旧 ParentProcessId 关联污染。当前 Node PID 6564 的启动/关闭在 2026-09-27T10:12:59Z；旧 PowerShell PID 4940、conhost PID 9040 创建于北京时间 10:21:21，早于当前 Node 约 8 小时，却因旧 ParentProcessId 数值一致被当作其后代。证据为 round-37-pid-reuse-probe.jsonl 和同名 mjs 配方。

## 修改

- execution-local-acceptance.js：以 PID + CreationDate 选择本轮根/子孙，子进程不得早于父创建，根直属子进程不得晚于根关闭；排空比较原身份，不把复用 PID 当作原进程。缺少相关创建时间继续失败关闭；缺少根所有权不执行 taskkill。
- 进程快照上限独立设置为 1 MiB，保留 10 秒检查上限；其他 PowerShell 输出仍 16 KiB。超限仍失败，不静默截断。
- execution-local-acceptance.test.js：添加确定性旧父 PID、复用 PID、真实后代存活、缺失创建时间拒绝、5000 行大快照；原候选漂移断言附完整 result 诊断。
- README 与 docs/ops/local-acceptance-review.md 同步上述行为。

## 验证边界

最终纯身份用例 3/3 PASS：round-38-process-identity-unit.log。round-38-local-acceptance.log 为中间首版实现的 18 用例，不能替代最终源码验证。最终 19 个本地验收用例由主代理正在运行的 round-38-core-final.log 209 用例组合覆盖，以该结果为准。

未修改运行实例，尚需由主代理重新打包部署并回读。没有提高业务执行超时、放宽安全门禁、跳过原失败用例或覆盖历史失败记录。

最终源码组合已完成：round-38-core-final.log 209/209 PASS、0失败0跳过，232.55秒；覆盖最终19本地验收用例。round-37-delivery-regression.log 90/90 PASS。本轮C30 PASS，round37 FAIL保留。新包09702705共84文件与源码一致，部署前零写Check通过，正在正常维护安装。

18:24正常维护部署完成：新PID20848，安装包097027050846ac5147a1cbd3ebc2362c6f14fed02fa95471c73c0c149ba322d4，84文件一致；16任务/76旧节点/21旧运行/68legacy校验通过，Web200、恢复问题0，维护revision24解除。双业务任务仍completed/succeeded且无等待提示。证据round-38-deployment-readback.json、round-38-tasks-readback.json。钉钉因原账号尚未授权仍degraded/inbound false，本次不声称真实新消息接收通过。

代码提交e14ae8e46c8764653a25a2fa775217987a998289已推送原分支，PR125状态OPEN、base main、head worktree-topic-context-completeness，标题及正文逐项独立回读匹配；未合并。原失败日志保留本地，PR正文与round37/38明确失败、根因与新结果，不将DWS授权待完成隐藏为通过。
