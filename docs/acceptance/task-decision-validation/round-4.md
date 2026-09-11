# Round 4：完成报告原生恢复

## 目标

在完成审阅重试耗尽、同一 Task 随后因人工介入报告进入 `waiting` 的现场，只重放已持久化完成报告，完成 Task、协调账、人工阻塞和结果通知收口；不得恢复叶子业务执行，不得重复代码、构建或部署。

## 已通过

- `node --test test/task-reports.test.js test/runtime.test.js`：123/123。
- `npm test`：416/416。
- 新增集成反例覆盖同一完成报告先 `failed`、后被旧 Runtime 写成 `rejected:task_not_active` 的遗留状态；协调恢复仍定位原失败事件和原 submission。
- 恢复权限仅限同输入版本、同运行轮次且存在 `topic_request_retry_exhausted:<requestId>` 持久失败事件的 completed 报告；普通 rejected、旧版本及已完成 Task 仍拒绝。
- 恢复审阅以当前 waiting 快照做 Topic、流程、检查点和候选一致性校验；通过后原协调账置 completed，当前人工阻塞转历史 superseded。
- 断言恢复前后叶子 Handle 创建/恢复调用数不变，完成报告接收事件恰好一条，完成 Outbox 恰好一条。
- 现场首次恢复已越过 `task_not_active`，但完成通知因已选择真实引用消息却漏填冗余 @ 列表，被 `group_reply_routing_required` 连续拒绝。修复为引用目标确定后默认只 @ 该发送人；群外 ID 仍 fail closed，并加入恢复集成断言。
- 同一 submission 在多次人工恢复中可能形成多个耗尽的 completion 请求；成功收口时按该 submission 的持久失败事件关闭全部关联协调账，避免旧请求永远残留 pending/exhausted。

## 待完成

- 固定源码包安装及安装目录哈希回读。
- 对 `task-a2695a23ab749ea2dd38ebb95b4d1f2a` 再次调用原协调恢复入口，并回读 Task、报告、协调账、阻塞记录、Outbox 与钉钉投递。
