# 第三轮：最终验收

均在隔离worktree、真实SQLite和Service/原生会话夹具执行，不使用线上控制库或真实钉钉发送。

| 命令 | 实际结果 | 覆盖 |
| --- | --- | --- |
| `node --test test/message-context-repair.test.js test/message-coordinator.test.js test/group-coordinator-session-native.test.js test/message-workflow.test.js` | 95/95，0失败，52570ms | 核心组合、原生会话、单元续办、重复动作、派发与重启 |
| `node --test test/message-context-repair.test.js test/group-coordinator-session-native.test.js` | 30/30，0失败，2456ms | 最后新增的历史提交竞态与初始legacy附件，及原生会话回归 |
| `node --test --test-name-pattern='澄清\|无引用回答\|待材料\|混合事项\|引用澄清\|任务准入授权\|旧版已答' test/workflow-service.test.js test/message-ledger.test.js` | 42/42，0失败，56139ms | Service14项、账簿28项，包括旧记录恢复与权限反例 |
| `node --test --test-name-pattern='提交使用模型\|读取目录\|澄清前须实际\|Host旧群历史\|原生澄清合同' test/message-coordinator.test.js` | 7/7，0失败，1705ms | 最后刷新sources与材料注册改动的关联回归 |

不同轮复跑存在重叠，按测试身份去重为139项：context9、coordinator56、native21、workflow11、Service14、ledger28。不能直接相加执行次数当成覆盖数量。

关键断言：历史270条以上可逐页读取、有效版本唯一、同时间戳前文存在；跨群/未来/水位后来源不可读。提交前最后异步校验之后插入历史v2，事务返回GROUP_COORDINATOR_SOURCE_STALE，独立查询commands=0且units=0。初始与窗口外legacy附件均读到真实夹具正文；刷新目录后旧分页权限清除。

混合消息补答只提交原unitId/spans，其他applied/pending/running/unknown命令与未答请求保持；重复补答不重派。pending和resolved通知引用均保留本条新任务与闲聊。相同动作改变replyPolicy仍拒绝，不同真实任务控制目标允许共享跨度。旧版补登记覆盖越权拒绝、后续待答阻断、已有命令阻断、幂等与重开库持久性。

独立审查最终未发现新增阻断问题。`git diff --check`与long-goal结构校验通过。没有部署、真实消息重放、真实模型准确率或渠道送达证明。
