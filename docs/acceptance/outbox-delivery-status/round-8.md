# 第八轮：取消状态与发送证据

## 现场与修复

2026-10-24 只读核查两个群共 151 条发信投影。业务群 136 条已送达、2 条发送前拒绝、2 条因后续订正而 superseded；测试群 11 条已送达。原生通知账共 182 条（包括未进入群发信箱的操作人通知），原始 body 摘要已保存于本机验证目录。

两个旧澄清在真实 Chrome 中显示“待确认／通知状态无法识别”，两条不可重试的失败提醒仍显示昨天的“计划重试”。修复沿现有通知账派生未发送证明，不新增生命周期状态；UI 加“已取消”并与异常、未知、已送达分开。七类取消原因用中文说明，来源标识和撤回原始错误移入消息记录。已有送达、未知、ACK、许可及历史缺证均有反例覆盖。

浏览器最初发现 390px 下表格撑开群列表，筛选位于屏幕外。最小修正群列表网格项宽度和工具栏换行后，保留四列及表格内部横向滚动，所有断言通过。

## 已执行验证

- `node --test test/task-message-projections.test.js test/task-notification-delivery.test.js test/coordination-notification-freshness.test.js`：50/50。
- `node --test test/observer-client.test.js`：30/30，另有独立审查 12 个反例通过。
- `node --test test/client.test.js test/http.test.js test/observer-node-control-display.test.js test/observer-slot-compatibility.test.js test/notification-retirement.test.js test/independent-coordination-recovery.test.js test/notification-pending-source.test.js`：139 通过，2 个原生环境用例首次因缺少完整宿主跳过。
- `pnpm test:release-smoke`：12 通过，2 个原生包用例同样缺少完整宿主；随后显式设置 `DSH_NATIVE_TEST_PROFILE=D:/dsh_home/profiles/web/package.json` 补跑。两个文件并行首轮分别触发 20 秒和 30 秒超时（不是断言失败）；不改代码或超时，单文件复验 source 11/11、package `--test-concurrency=1` 2/2 通过。原失败用例耗时分别为 1.287 秒、26.443 秒。首轮具体耗时瓶颈未收敛，保留失败日志，不能据复跑猜定 CPU 或磁盘原因。
- 合计上述 235 个不同测试最终均有通过结果，未以跳过算通过。测试映射检查覆盖 303 文件，无遗漏。
- 现有浏览器脚本已修正旧断言和宿主依赖参数：`node docs/acceptance/resident-completion-notification/scripts/verify-outbox-ui.mjs C:/Users/64554/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright D:/dsh_home/profiles/web/node_modules`。10 个场景、六状态筛选、四列、键盘、刷新保留、390px 筛选/滚动/诊断换行全部 PASS，0 页面错误、12 HTTP 请求全部拦截、0 DWS 外发。该层为真实 Observer 加宿主/HTTP 替身，不代替部署核验。
- 本机原通知只读套用候选投影与真实分类器，结果为已送达 147、异常 2、已取消 2；异常重试计划为 0。

本机详细证据与截图：`docs/tmp/outbox-cancellation-status/`，不入库；浏览器脚本和上述命令为再生成入口。部署与真实浏览器回读在本轮下方追加，状态以 matrix.csv 为准。
