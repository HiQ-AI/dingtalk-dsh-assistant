# 第一轮实现与问题定位

日期：2026-09-28至29。

- 新增服务端用例最初因夹具缺少webActor、未绑定下一阶段输入、需求更新缺少eventKey以及空结果应为null而失败；按真实契约修正夹具，未降低断言。最终6个选中用例通过。
- 相关回归：`node --test --test-concurrency=4 test/workflow-service.test.js test/http.test.js test/execution-task-plan.test.js test/execution-store.test.js test/task-progress.test.js test/observer-client.test.js`，228/228 PASS，0 skipped，76919ms。
- 三个真实完成任务一致SQLite副本：63节点、97页、54267字符，计划顺序、当前代次、精确工件、旧ID映射通过；禁止写入口调用0次，副本和正式业务表不变。运行日志表正常变化。此证据不等同正式部署。
- 首轮受控部署包通过Check（writes=0），维护封存、完整备份、双包安装、原记录验证均成功。回读旧脚本误把所有物理任务ID当看板卡片ID而失败；11个不在合并卡片中的ID独立GET详情均返回200且映射最新任务。修复回读校验，仍保留数据库完整性检查。
- 首轮Observer源在安装后追加方案内阅读定位修复，源码比对准确拒绝旧包。以此前Check源包证明、原包摘要与安装文件独立比对、21任务/76旧节点/27终态run/68legacy记录完整性、认证页面200和实际完成任务接口通过作为恢复依据，经正式resume API恢复派发。未编辑数据库或安装源码。

原始日志、任务ID、截图与业务正文仅docs/tmp/task-current-steps；本轮部分失败保留，不宣称首轮全绿。
