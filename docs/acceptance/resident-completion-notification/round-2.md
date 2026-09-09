# Round 2 复查修复

日期：2026-09-09。前一轮“上下文受限”的结论仅覆盖多条短消息；复查发现单条超长原文可越界，本轮以硬预算及分段续读修正，并补充反例。

## 自动化验证

- `node scripts/build-web-client.mjs`：完成，已提交生成文件内容无变化。
- `npm test`：304 个测试通过，0 失败、0 跳过。日志暂存 `docs/tmp/workflow-notification-review/full-regression.txt`。
- `git diff --check`：通过。
- 流程修改/停用/删除无需重载即拒绝旧阶段；删除后重建同 ID 的修订号不会回退；审阅期间与通过后落盘前改版都不能完成任务或发通知。
- 无计划、拒绝计划、过期流程下可以报告冲突；异常报告不能伪造进度，抢占待审时旧回执不能写回。
- 重启遇到过期待审计划会归档失败项，允许重新规划；审阅通过后并发暂停保持 waiting/Goal blocked，不产生完成通知。
- 单条长消息、JSON 转义、多段连续读取、40k 信封、漏选候选、多流程组合与诊断豁免均覆盖；通知回退使用相同预算及读取工具。
- 组织未授权时不发送；空回执、失败回执和只有受理 ID 都不能替代真实消息回读，缺少真实 messageId 不能确认。
- 完成审阅起点在发起时持久化，拒绝和失败也留下带尝试标识的事件。

## 浏览器验证

复现命令：`node docs/acceptance/resident-completion-notification/scripts/verify-outbox-ui.mjs <playwright-package-directory>`。本机使用 `C:/Users/64554/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright`。

独立无头 Edge 加载真实 Observer 脚本，HTTP 和 DSH 宿主使用合成替身。7 种投递状态、键盘筛选、390px 长错误换行及徽标显示通过；0 页面错误、0 真实 DWS 请求。这是合成页面验证，不是钉钉真实收发验收。截图保留于本地 `docs/tmp/workflow-notification-review/`，不提交二进制。

## 部署与外部边界

- 本地部署：源码提交 `d9217a6d60fcdf4ba231b39be247a6779d0cd832` 的唯一 tgz 已安装到 web profile。Assistant SHA256 `D975C97730BC4583D991064DEFBE5CBE8992F6A9C069CA8C2F5E91E2C9755EAE`，Observer SHA256 `699E6F1D5CF8FEA9E4B5C3DAB740F89699FD3F272BC531E86EF674E29C9ED0ED`。六个 Assistant 修改文件及 Observer web-client.js 均与源码 SHA256 一致。
- Runtime：3080/18998 同属新 PID 33400；带启动地址认证访问 HTTP 200；独立无头浏览器打开运行看板，0 pageerror、0 API 401/403。配置完整摘要与安装前一致，taskPromptsVersion=3、10 项流程，profile patch 未变化。
- `/health` 为 degraded，recoveryIssueCount=0；群与人工回复 listener ready，历史补拉仍 dws_read_failed:1。部署没有解决 DWS 组织权限，不将监听就绪等同于真实收发通过。
- 运维命令修正：全局 dsh shim 指向已删除目录，改用 profile 内原生 bin.js 安装并同步 runbook；未修改全局 CLI 或其他插件配置。
- DWS 组织权限：用户明确交负责人处理，本轮不登录、不强制重试、不补发消息。真实发送/回读保持未验证。
- 任务流程内容仍由插件配置提供；无匹配和多流程组合均允许。索引是审阅发起时快照，仅已选或已读候选修改使审阅失效，不声称自动发现运行途中后来新增的适用流程。
- 不承诺模型一定正确理解流程；门禁保证的是版本、来源、完整读取与状态一致性。

## 交付

PR [#86](https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/86) 已更新为“优化常驻完成通知并修复流程审阅与送达确认边界”，base=main、head=feature/resident-completion-notification、状态 OPEN，远端代码修复提交 d9217a6 已回查。后续验收文档提交不改变安装的产品源码。真实 Outbox 只读回查看到 3 条需要回读的 pending，其中 2 条记录 preflight_failed；本轮未把受阻消息改成 sent。
