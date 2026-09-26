# 第十四轮：任务步骤耗时

- 编号步骤显示真实本次执行耗时；运行中每秒更新，重试带租约轮次，等待只显示本次执行耗时，未执行与缺失记录明确标注。
- Worker 从已提交事件按 seq 增量分页恢复 claim/commit 时间，仅保留时间元数据，不改 schema，不新增诊断 API 请求。查询 DTO 增加 startedAt/completedAt，业务命令不变。
- node --test test/execution-store.test.js test/observer-client.test.js test/workflow-service.test.js：105 PASS，0 FAIL。覆盖首次开始、完成、重开恢复、租约重试与幂等；原 observer 抽取测试因组件插入位置失败，调整组件位置后通过。
- 独立 Edge、完整 React/observer：30 项通过，23 次只读请求（含新增手动刷新 6 次），0 写入、0 页面错误；运行计时更新、等待、未开始、缺失记录、编号、窄屏均通过，未调用 /state/task-timings。
- strict 静态审计 0 findings；node scripts/build-web-client.mjs 通过。桌面截图已查看；示例数据不代表真实业务。
- 安装及在线回读待执行。
