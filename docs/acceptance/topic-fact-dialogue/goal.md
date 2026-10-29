# 任务报告事实，Topic 负责对话

2026-10-29：云端实现、针对性回归和独立只读审查完成，初始提交 `4da1abbc0157a74146a4ae5021ded742662c4e56`。原基线为 `9dd585f0a5c6567f78313c4662c516f9c40c2964`，分支 `feat/topic-fact-dialogue-cloud`。用户随后授权提交 PR、合并及百部本地部署；本线程整合最新 main 并交付 PR，部署由百部原部署线程执行。没有实现 A→B，也没有启用独立协调服务。

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

发布前重新核对，[PR #291](https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/291) 已合并，最新 main 为 `392a2d1c25e476f314cf0c782d6f77b9c18895b1`。已将该 main 整合到本分支，三处文件的文本冲突均保留双方合同：

- `task-session-service.js` 的来源/replyBindings 与 admission hold、旧 Owner 排空、Host phase 计时同时保留。
- `topic-runtime.js`、`task-topic-coordinator.js` 同时传递事实处理和冷归档读取；归档/参数校验继续生效，跨 Topic 同源仍只允许指定 replyTopic 确认。
- 旧 Web 请求键序恢复、原文 UTF-16 覆盖诊断和共享测试断言保留，不整合其他仍 open 的 PR。

本次整合实跑 399/399、0 fail/cancelled/skip：`merge-regression.log` 371/371（动态账、Topic、事实、原生路由、归档、资源和计时）；`merge-native.log` 14/14（原生取消排空、更新 fence、容量、创建失败、unknown 回查和来源）；`release-smoke-direct.log` 14/14（发布流程/包、实际打包后模块与隔离 resident 健康）。后者执行 package.json 中 `test:release-smoke` 的完整 `node --test` 命令；直接 `pnpm test:release-smoke` 的包装器因云端默认缓存目录 ENOENT 失败，原日志保留，不算通过。没有修改依赖或跳过测试。327 文件映射和改动 JS 语法检查通过。以上与前轮 494 项有重叠，不累加；前轮三项基线失败仍按原结果披露，未伪装全量通过。

独立 reviewer 对此次整合仅做只读复核，确认接纳锁/旧轮排空与事实异步唤醒相容、两组参数传递完整、归档校验未被免重复确认逻辑绕过；未发现新增阻断。reviewer 没有运行测试。

普通 PR 无自动 CI，仓库指引也不允许因提交/合并/部署请求手动触发 CI；GitHub 读回 main `protected=false`、required status checks 为空、rulesets 为空。合并时仍回读实际 PR 检查，不绕过失败检查，不提交 approve review。正式版本 Tag 发行的全量 Release CI 不在本次本地部署范围。

本次新增的 `dynamic_topic_facts` 表和索引由 Task store 启动事务幂等创建；不重建或清空原数据库，不 Bootstrap、不回放历史任务/消息。按 [已初始化实例更新核验](../../ops/task-session-clean-start.md#已初始化实例更新核验) 从合并后的准确 SHA 构建并核对双包（Observer 同样显式固定），先 Check、排空再切换，独立核对包摘要、安装、新 PID 和健康。回退保留事实账和通知账；旧代码不消费待处理事实，不能靠清表、重放或重发解决。

#291 作者回执未计入本次验证。真实模型、真实钉钉通知、现场 #411 及百部实际部署仍未在云端验证；新消息验收分别核对 Task 完成、Topic 事实处理及通知送达，unknown 只回查原发送。
