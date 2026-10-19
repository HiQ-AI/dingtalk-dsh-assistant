# 运行中任务补充协议（issue #208）

## 根因与范围

main c2e5faa 的话题补充无差别执行 task.revise → cancelLiveTask；统筹带 executionId 的委派无差别进入 execution.continue，活动执行被 DYNAMIC_EXECUTION_BUSY 拒绝。修复只增加持久补充与原执行投递，不删除 busy 校验、不启动第二运行者、不托管后台作业。初次读取时 PR #207 仍 open（head 0451e49）；提交 PR 前已合并到 main 847ee32，包含 provider 冷却复核及有序列表通知回读修复。本分支已基于新 main 重放，保留其独立实现；仅给其需求修订测试提供本次必填分类及明确的新增核验要求。

## 输入与版本

- progressImpact 为协调工具 schema、HTTP context API 和服务入口的必填语义声明：preserve 确认目标、授权、验收、阶段和证据有效性不变；replan 明确声明真实变更，须使旧判断失效。缺失分类会明确拒绝，原执行保持，不默认 preserve 或 replan。无法判断须读取来源补判，仍不明确则不提交任务动作；不会根据关键词猜测收权。
- preserve 与授权、目标、验收、阶段、证据或标题变化冲突会拒绝，不静默升级为修订。确认 preserve 后 task.supplement 持久保存原消息身份，不提高 requirementRevision、不取消执行。明确取消走专用 task-cancel/cancelTask，不依赖补充分类。
- DTO 的 contextInputContract 公开必填值和缺失时拒绝行为。历史持久动作即使绕过新 schema，应用前仍做同一校验；直接服务调用在持久接收前校验，HTTP 缺字段返回 400。旧调用方须提供分类，无兼容默认值。
- 独立 contextRevision 使旧统筹判断失效；新统筹沿原任务读取新来源。普通补充不代答或清除 operator 人工请求。明确目标/授权变化优先于 requester 人工答复路径，修订并停止旧执行。
- 统筹以 task_delegate(executionId, feedback:true, key, objective, context) 发送不改变目标和授权的澄清。key 去重、同身份不同正文拒绝；feedback 不能混用调查或资源/技能变更参数。已终结执行返回明确拒绝，应核对结果后显式续办。

## 接收、投递与消费

每条 feedback 保存 id、正文、需求/控制版本、接收 inputVersion、receivedAt、modelStepEnteredAt（兼容字段 consumedAt）和原生日志 sequence。consumptionMeaning 固定为 native-model-step-admission，只表示进入原生模型步骤。接收事务先于投递；执行尚未建立句柄或正在工具内时仍保留记录。重复请求回读当前步骤准入状态。

核对安装的 @deepseek-ai/dsh-agent-loop 0.2.1-alpha.2：steer 调用 send(next-step,true)，只入 Inbox 并唤醒，不取消当前工具。pre-step 时原生已 claim Inbox；step/start 在 user/message 前，user/message 在模型请求构建前写入。实现以固定消息 ID 去重，在原执行下一安全步骤投递；看到确切 user/message 及步骤边界、flush 原生日志后才落 consumedAt。该状态表示进入原生模型步骤，不表示模型理解、业务动作完成或真实模型服务已成功响应。单纯 steer 返回、inbox/spliced 或工具受理回执均不是消费证据。

模型步骤只可用自己已见的反馈版本启动后续工具或提交。步骤生成期间收到补充时，旧步骤工具可纠正地被拒绝，下一步骤读取消息后重新判断；正在运行的原工具保持。明确取消和真实需求修订仍通过现有版本与 abort 路径停止工作。

## 完成与恢复

execution.result 事务比较步骤反馈版本及未消费记录；task.complete 同时检查新 contextRevision 与未消费反馈。submit 已受理、结果落账前收到补充时，不落普通失败：原运行排空，再调度同 executionId/sessionId/inputVersion，递增租约，读取补充后重新提交。原成功工具结果保留，不自动重放外部动作。

恢复不能用当前 consumed 数量为历史 submit 背书。只有所有当前反馈的原生消息都在该 submit 之前、且有成功提交回执时才可恢复旧提交；补充已读但未新提交的重启必须重新形成结论。已投影消息不再次 steer；仅 claim、未投影的消息可在重开时重新投递。数据库接收/消费事务和原生日志不是跨存储原子事务，顺序采用先接收、先 flush 证据再记消费，恢复依据固定身份核对。

## 审查与验证记录

实施前做独立短方案审查；代码后独立审查发现并修正：完成竞争落错误终态、恢复用当前消费数量采纳旧提交、可选 authorizationChange 误判以及人工等待覆盖明确授权变更。审查未增加业务验收。

同一新增完整原生 shell 用例在 main 源码失败：普通“开发分支别搞错了”使 requirementRevision 从 1 变为 2；修复后原作业、executionId/sessionId/inputVersion/lease 保持，用户提醒与统筹澄清从 received 到 consumed，各投影一次，真实文件写入一行 once。另有完成竞争原生测试验证同会话恢复、租约递增且 shell 写入不重放；三轮 JSONL 重开验证旧提交不能覆盖新输入。

真实协调入口补强用例从群消息进入路由、原生 group_decision_submit、服务和真实 shell，覆盖缺字段、提醒 preserve、目标 replan、明确 cancel 四种情况。缺字段用例在 main 原码失败（需求版本 2 != 1），修复后明确拒绝且原执行继续；并未默认 preserve。Zod 与实际原生工具 JSON schema 均拒绝缺字段；HTTP 缺字段及语义冲突均返回 400，直接服务入口返回 TASK_CONTEXT_CLASSIFICATION_REQUIRED，DTO 公开同一契约。生产模型的判别准确性仍未验证。

在初始基线 c2e5faa 上，本地回归设置 `DSH_NATIVE_TEST_PROFILE=test/fixtures/native-profile/package.json`，运行 15 个相关文件，453 PASS、0 FAIL、0 SKIP（34.695 秒）：

| 范围 | 文件 | 通过 |
| --- | --- | --- |
| 核心存储、原生执行/任务/人工、Inbox | dynamic-task-store、execution-session-native、task-session-service-native、task-session-human-native、topic-native-inbox | 228 |
| Schema、HTTP、话题契约 | decision、group-decision-contract、task-session-http-integration、http、topic-store、topic-runtime | 208 |
| 原生入口与恢复兼容 | task-topic-routing-native、task-web-topic-reuse-native、model-context-files-native、task-session-job-recovery-native | 17 |

上述均为 test/ 下对应 .test.js 文件。包括无新增消息的原委派/续办/恢复、真实进程取消、旧结果失效和来源身份回归。`git diff --check` 通过；未运行全量测试或 CI。

提交 PR 前以已合并 #207 的 main 847ee32 为基线无冲突重放。复跑以上 15 文件（包含新 main 的新增用例），并增加 task-session-execution-provider-recovery-native.test.js 与 task-notification-readback.test.js，共 17 文件、476 PASS、0 FAIL、0 SKIP（37.758 秒）。保留 #207 的独立冷却复核与通知回读机制；仅将其需求修订夹具迁移到本次必填分类契约。仍未触发 CI 或部署。

验证使用仓库 test/fixtures/native-profile 的真实 AgentLoop、会话、JSONL、工具、shell 与 SQLite，模型适配器为确定性脚本。存储定向测试不代表模型或现场；测试中的人工故障注入不代表真实进程崩溃。未部署、未操作业务任务，真实钉钉、生产模型及现场进程崩溃恢复仍待验收。不会因本文记录声称 #208 已现场闭环。
