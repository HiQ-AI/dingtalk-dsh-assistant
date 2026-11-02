# 配置加载与消息接入控制验收

## 验证对象

2026-11-02，Windows 11，Node.js v24.19.0、pnpm 10.13.1；基于 origin/main `27416826` 的 `worktree-plugin-config-speed` 工作树。本轮为未提交源码验证，提交前不再修改已验证代码；最终提交号见 PR。现场只读测量不代表新代码已部署，未调用线上暂停/恢复接口。

## 原因与测量

旧 `readResidentOverview` 同时等待 health、groups、完整 tasks、alerts、environment、agent-config。环境检查启动 DWS auth status 子进程；群详情带消息历史。并行发起不能解除 Promise.all 的最慢项阻塞。

本机现有实例只读请求（不记录内容、身份、凭据）：

| 路径 | HTTP | 耗时 ms | 响应 UTF-8 字节 |
| --- | --- | --- | --- |
| /health | 200 | 138 | 1119 |
| /state/agent-config | 200 | 1227 | 405 |
| /state/groups | 200 | 1276 | 7852489 |
| /state/environment | 200 | 5534 | 271 |
| /state/tasks?offset=0&limit=1&view=summary&state=running | 200 | 1285 | 311 |
| /state/supervisor/alerts?offset=0&limit=1 | 200 | 1286 | 113 |
| /state/groups?summary=true（后续单独测量） | 200 | 234 | 4604 |

这不是严格同一时刻的端到端浏览器测速；可断言群摘要保留表单字段而体积约减少 99.94%，环境检查不应参与核心表单的等待。

将 base 与工作树生成 bundle 分别装入 Node VM，以同一个 fetch fixture 对 environment 注入 200 ms 延时，调用实际导出的 readResidentOverview：base 等待 210.97 ms；新实现 0.12 ms。该实验只证明依赖解除，不宣称真实浏览器达到 0.12 ms。版本检查原来已经异步，因此不是首屏被环境拖慢的根因。未用缓存或降低命令超时制造表面提速。

## 实跑结果

- `node --test test/client.test.js test/client-reply-signature.test.js test/dws-bridge.test.js test/http.test.js test/store.test.js`：152 pass，0 fail，0 skipped（后续新增在途接收用例单独复验见下）。覆盖配置回显、辅助失败隔离、保存时慢探测继续回显、存储重开、控制身份/参数、暂停恢复与失败重试。
- 最后一次桥接回归 `node --test test/dws-bridge.test.js`：58 pass，0 fail，0 skipped。包括旧监听迟到事件、暂停时历史请求未结束、跨日持久下界、新事件先于旧补拉、失败恢复、无群恢复和暂停等待可靠接收排空。
- 最后一次 UI/bundle 回归 `node --test test/client.test.js test/client-reply-signature.test.js test/web-client-build.test.js`：16 pass，0 fail，1 skipped。包含最终 /health 恢复轮询实现；真实生成器构建、语法加载、二次构建字节一致、产物与源码一致全部通过。
- `$env:DSH_NATIVE_TEST_PROFILE = (Resolve-Path 'test/fixtures/native-profile/package.json').Path; node --test test/web-client-build.test.js test/dws-adapter.test.js test/execution-configuration.test.js`：46 pass，0 fail，1 skipped。DWS 适配器与相关历史执行配置合同通过；指定 profile 后宿主 client registry 集成仍因缺少 `@deepseek-ai/dsh-client-modules` 跳过。未安装新依赖掩盖环境缺口。
- `pnpm test:suites`：verified 335 files; every file exactly once; historical 3; deleted 0。
- `git diff --check`：通过。

上述批次存在交集，不相加为测试总数。开发初次回归有 3 个旧契约断言失败（概览仍期待辅助字段、版本请求实现字符串、health 精确对象未含 ingress），随新合同更新后通过；没有删除测试、降低失败断言或跳过功能路径。中间完整日志只用于定位，关键结果已归入本报告，交付前清理。

## 结论与边界

核心配置仅等待健康、群摘要、Agent 配置；任务/告警使用分页 total，环境/版本分别加载并显示错误，不以 0 或未安装掩盖失败。旧代次辅助结果不能覆盖新刷新，保存也不会让未完成探测永久失联。

暂停状态和恢复下界先持久化再切换。暂停关闭群监听、禁止自动历史接纳并等待在途可靠接收结束；重启保持暂停。恢复重建监听，沿恢复下界补拉和去重；只有所有订阅群监听 ready、完整历史可靠接收成功且无待恢复状态，才清除持久下界。暂停并非取消已接纳任务，也不暂停外发与操作者私聊审批。上游不可读、删除、过期消息无法承诺恢复。

未验证：真实 DSH 浏览器点击/视觉验收、宿主 client registry 集成、真实钉钉暂停期间发消息后的补回、安装/部署与业务 E2E。未运行全量测试或主动触发 CI。回退旧代码不保证保持暂停；应先完成补拉再按 runbook 更新/回退。
