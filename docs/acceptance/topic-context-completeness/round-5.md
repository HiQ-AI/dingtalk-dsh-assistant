# 第五轮：本地部署与真实数据回读

## 部署中发现并修复

- 早期 v4 话题事实没有显式 status；原迁移检查拒绝，原库未修改。历史 b3036eb 的事实写入确实不包含 status。迁移对缺失状态按准确来源版本补为 active/invalidated，并写 migrationReason；非法状态、来源缺失继续拒绝。增加缺省状态与旧版本来源回归。
- `answer` 本来会创建 Task，但 message.task 来源查询漏掉该类型，真实任务历史返回 404。补入既有动作类型并新增 answer 来源/历史回归；不修改历史任务。
- 执行 runbook 的 build-web-client 后生成内容与版本库语义一致，只有换行差异。

## 实跑

- 存储与账本：61/61 通过，见 round-5/migration-tests.log。
- 最终服务、账本、存储组合：134/134 通过，0 失败、0 跳过，34.35 秒，见 round-5/deployment-fixes-tests.log。
- 停机前 72 completed、1 waiting、0 running/queued；迁移 unknownEffects=0、pendingApprovals=0。
- 停机备份在仓库外 `D:/dsh_home/backups/topic-context-20260926-1121408`，包含 profile 清单/锁/patch、控制库及工件、Domain 存储、553 个会话文件（2906115472 字节）。工程依赖全量复制中断，部分副本不作为完整备份；源工程目录未修改。副本迁移通过后再迁移原库。
- 原库独立回读：user_version 和 schema_version 均为 5，instanceId 保持原值，9 话题、30 事实（24 active、6 invalidated），integrity_check=ok、外键错误 0。迁移前后七张保留表的数量与摘要一致，完整备份与迁移输出仅保存于仓库外。
- 安装 assistant/observer 本地 tgz（版本号仍为 0.5.15），首轮 83 个 JS/patch 文件逐项哈希匹配；answer 修复后 Assistant 使用独立 r2 tgz 重装。最终还需以安装文件哈希核对记录为准。
- 关闭入站启动新进程：health=ok、recoveryIssueCount=0；真实消息 trace 5 条，9 个话题上下文合计 24 条有效事实，原业务 Task 历史 1 个 Run，带认证 Web 请求 HTTP 200。

## 边界

未发送测试钉钉消息，未重放历史业务任务，不把健康和只读回查当作新消息端到端验证。原 PR 尚未合并，此次按用户授权部署本地分支构建。最终入站健康与安装哈希见本节后续记录。

## 最终回读

新 PID 17048 同时监听 3080/18998；health=ok、inboundProcessing=true、recoveryIssueCount=0、DWS healthy=true、listener=ready、backfill=ok。恢复原 profile patch 后 SHA256 与备份一致。最终安装的 83 个 JS/patch 文件全部与本次源码哈希一致。answer 的来源、候选召回及最近命令查询一并补齐，新增断言定向实跑通过。未执行真实渠道测试消息。
