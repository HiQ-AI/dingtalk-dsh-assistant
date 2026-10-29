# 任务报告事实，Topic 负责对话

2026-10-29：云端实现、针对性回归和独立只读审查完成。基线为 `9dd585f0a5c6567f78313c4662c516f9c40c2964`，分支 `feat/topic-fact-dialogue-cloud`。仅在云端本地提交；没有推送、合并、部署或触发 CI，没有实现 A→B，也没有启用独立协调服务。

## 实现

- 复用移交补丁：原 ZIP 60,208 bytes，SHA-256 `97004ca947aa666f1c91b3e95005ac0a070f28e2d7cc65c279dcdfeb85974adb`；14 个源码文件按清单核对后应用。
- Owner 完成、阻塞、重要结果与人工 followup 仅提交事实；任务状态和待处理事件同事务落账。任务完成不等待 Topic 或通知。
- 来源显式选择现有 replyTopic；其他业务 Topic 继续动作但不重复确认。任务按本轮来源绑定，不广播历史 topicRefs。混合来源中可继续全部动作，回复关联只覆盖自己负责回复的来源。
- 事实绕过 Route，进入现有 Topic Decision，只能回复、沉默、维护摘要；不增加 Agent，不循环创建任务。串行合并已到达的相关受众事件，不加等待窗口。
- 决定和冻结回复意图同事务保存；沿原发件箱发送。发送失败复用正文，unknown/starting 只核验；保存事实、来源、Topic、Task 和钉钉送达消息关联，引用可反查 Topic。
- 任务/来源/回复默认数据库投影限制字段和行数，归档同样提供有界摘要；完整证据按需读取。事实唤醒进入已跟踪的群队列，并跳过任务和来源全表缓存刷新。
- 人工问题已解决时，未发送的混合回复退役，其他完成事实重新进入 Topic 判断；新意图与投影使用新的决定身份，迟到旧投影不会覆盖新代次。待处理事实阻止取消订阅，单条投影失败不阻断其他恢复。

## 实跑证据

环境为 Node 24.19、pnpm 11.25.0；native profile 仅用于隔离测试依赖，未加载生产凭据。模型使用 scripted adapter，通知使用测试桩。

| 日志 | 通过 / 总数 | 说明 |
| --- | --- | --- |
| `final-core.log` | 423 / 425 | 任务账本、Topic、事实、格式、发送/回查、HTTP、resident 配置；2 项基线失败见下 |
| `final-native.log` | 57 / 58 | 人工 followup、身份、Topic 路由、恢复、共享材料历史、包验证；1 项基线失败见下 |
| `service-final.log` | 7 / 7 | 原 native 失败场景复验，包括 Web 来源、不同用户续办、执行恢复、unknown 回查及会话创建失败 |
| `final-notification-native.log` | 1 / 1 | 正式完成后退役未发送确认，不重新派发 |
| `final-topic-http.log` | 3 / 3 | Topic 上下文、引用关联接口与审计读取 |
| `audit-final.log` | 165 / 165 | 独立审查修复后的 Topic/事实/路由回归；与上表重叠，不累计 |

前五组共 494 项，491 通过、3 失败、0 取消、0 跳过。3 项均在未修改基线工作树上用同一测试依赖逐项复现（`baseline-three-failures.log`，3/3 同样失败），没有修改或跳过它们：

1. `task-background-retry-native.test.js`：`coordination exact recovery retains reservation generation...`，暂停中的协调恢复返回 `MESSAGE_RETRY_UNAVAILABLE`。
2. `task-session-http-integration.test.js`：`notification service manual recovery preserves pending-source send fences`，协调通知恢复返回 `TASK_NOTIFICATION_RECOVERY_FORBIDDEN`。
3. 同文件：`manual recovery releases the serial slot...`，原回查/发送可并行，断言期待 `prepared` 而实际为 `starting`。

本功能必需场景已验证：跨 Topic 同源并发只确认一次、新结论可回复、事实不建任务、持久重复与重启不重放、任务与投递解耦、引用反查、有界查询、失效人工问题与混合结果、归档摘要以及投影恢复。独立只读 reviewer 最终无尚未修复的阻断发现；reviewer 未运行测试，以上为实施线程实跑。

查询实测：2.4 MB 源数据输入，2 个事实、2 条来源、3 个相关任务；实际 4 条 SQL 均在查询层限制字段/行数，返回 16,365 UTF-8 bytes，Topic 上下文 16,382 bytes，预算 22 KiB。一次云端采样查询/投影 76.4 ms；这是本地查询采样，不代表实际模型耗时或性能承诺。

日志存于交付包；原移交日志 `dynamic-task-store.log`（147/147）、`topic-regression.log`（167/180）保留在交付证据的 original-handoff-tests 目录，不能作为最终代码验证结论。测试映射保留现有分类并新增事实用例，`test-suites.mjs check` 验证 327 文件恰好映射一次。

## 兼容性与未验证边界

交付前只读核对 origin/main 仍为上述基线。[PR #291](https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/291) 仍 open、未合并，head `0ce9b754ee9d072d73427b868f81515aabe56154`。已读取相关文件补丁，未整合它：

- `task-session-service.js` 的任务动作接纳区域同时涉及本次来源/replyBindings 和 #291 的 admission hold/旧 Owner 排空，后续整合须保留两边。
- `topic-runtime.js`、`task-topic-coordinator.js`、`decision.js` 的参数和归档合同有相邻改动；本次归档状态摘要不替代其明确 ID 的冷归档读取/参数校验。
- `dynamic-task-store.js` 与 `topic-model.js` 两边都有修改，内容分别是事实账/归属与 Host phase/覆盖诊断；共享测试文件可能产生文本冲突。
- #291 作者回执未计入本次验证；合并后的组合行为、真实模型、真实钉钉通知及现场 #411 均未验证。
