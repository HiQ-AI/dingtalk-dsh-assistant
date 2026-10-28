# 同一 PR 最终验证

Base: main 56483462ca81943ecd23cb6144644d8946acf897。
固定类别实现提交 18ea7c57；执行卡片提交由 a15af6b7 整合为 20b54b86；前序通知/提示提交 6a7db266。最终收尾将通知按各一个发送/回读位置分阶段调度，保留同通知单飞、发送退避、unknown/starting 只回读及完成通知事务。

最终命令：

node --test test/fixed-topics.test.js test/topic-runtime.test.js test/topic-store.test.js test/dws-adapter.test.js test/dws-bridge.test.js test/session-workspaces.test.js test/task-notification-delivery.test.js test/task-operator-notification-scan.test.js test/notification-pending-source.test.js test/task-notification-readback.test.js test/notification-recovery-tool.test.js test/observer-message-projection.test.js test/release-artifacts.test.js test/observer-pagination.test.js test/observer-client.test.js test/http.test.js

结果：492 项，485 PASS、0 FAIL、7 SKIP，13.32 秒，见 final-core.log。固定类别专属16项与真实 Route 混合分流覆盖在此命令内。新增隔离 SQLite 用例证明 deferred ACK 后重启只回读，不重发；合成调度证明 A 群回读阻塞不挡 B 群发送，同时回读保持单飞。

7 SKIP：notification-pending-source 的3项 native profile 用例；task-operator-notification-scan 的4项 native profile 用例（含原生限流）。原因：本 worktree 未安装 @deepseek-ai/dsh-base resident profile，未调用真实服务补测。合成、SQLite、静态及 Node 回归不能代替真实群送达或现场性能验收。

node scripts/test-suites.mjs update / check：325文件逐一登记，历史3文件，删除0。新增模块进入 npm pack --dry-run --json 文件清单（92个文件），没有发布包。git diff --check 通过。

卡片原线程提供过159/159与合成Chrome慢/失败/重试/空态证据；本线程整合后重跑涉及的HTTP/客户端/分页Node回归，不把先前合成浏览器结果当真实运行看板已验收。详见 docs/spec/execution-card-loading.md。

未实施 Route/Decision 合并；未恢复旧 coordination 派发。没有数据库迁移、真实库操作、真实群消息、合并或部署。
