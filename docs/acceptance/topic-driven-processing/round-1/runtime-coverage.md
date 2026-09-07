# Runtime 旧用例覆盖映射

对照基线提交 `0925f0d4ed4f49072454f563477f433b10ebb61d` 的 `test/runtime.test.js`，共 70 个具名测试。当前 Runtime 58 个、Topic coordinator 26 个，共 84 个测试实跑通过；数量仅用于核对，不能代替行为覆盖。状态总表仍以 `../matrix.csv` 为准。

本轮命令：`node --test test/runtime.test.js test/topic-runtime.test.js`，结果 84/84 PASS，0 fail / 0 skip。测试使用真实 openResidentStore + DomainFacility 内存持久后端，DSH agent、模型工具调用和故障门控可控；真实 DSH 服务验证由独立 native E2E 记录提供。

## 迁移原则

旧 observedRequestIds、关联复核、逐消息 steered 屏障属于被替换的设计，不能原样迁移为“所有消息继续串行检查”。保留的业务不变量落到 Topic 批次完整性、固定revision、basis授权、持久操作幂等和原子Outbox门禁。

Task删除原文副本以后，群退订必须保护被Task引用的Topic；旧“删除群后仍留下完成Task等待通知”不再允许用合法API制造。历史导入现在只steer索引，不再存在等待Resident空闲才导入正文的路径。

## 逐项映射

| 原编号 | 原测试 | 处理 | 当前证据/设计差异 |
|---|---|---|---|
| 1 | Inbox 默认零延迟 steer，回复提交门禁不退化为定时聚合 | 协议替代 | 不再以 steered/observedRequestIds/全群顺序作为提交门禁；Topic exact batch、独立 A/B、pending routing-required、同 Topic revision stale、失败日志定时恢复与精确重试分别覆盖。旧“阻塞其他消息”断言与本次目标相反，不保留。 |
| 2 | 普通群消息只携带历史回复候选计数并可按请求读取完整快照 | 保留并加强 | Topic 请求仅计数；group_reply_review_get 读候选；读前、读后、Store 原子提交点刷新；无关 B 不使 A 失效。见 topic-runtime.test.js 的候选与原子竞态组。 |
| 3 | 任务摘要索引不展开历史且只读工具按需返回完整关联上下文 | 数据模型替代 | Task 仅 topicRefs；runtime 的任务摘要/叶子固定版本读取、topic-runtime 的分页/跨群/越界、topic-store 的多引用与 CAS 覆盖。原 sourceMessageIds/messageHistory 多对多正文副本删除。 |
| 4 | 同一turn的多条消息按step工具提交独立Decision且不等待turn结束 | 协议替代 | 不再以 steered/observedRequestIds/全群顺序作为提交门禁；Topic exact batch、独立 A/B、pending routing-required、同 Topic revision stale、失败日志定时恢复与精确重试分别覆盖。旧“阻塞其他消息”断言与本次目标相反，不保留。 |
| 5 | DWS listener 恢复会关闭退出和启动异常两类 carrier 告警 | 保留 | Runtime：DWS 恢复关闭同群 carrier 告警且不误清其他异常。 |
| 6 | 模型可合并相关请求且Runtime只提交一次副作用并保留全部来源 | 保留并加强 | Topic 持久操作日志与稳定 operationId：已建 Task 后故障重启一 Task/一 Outbox；共享来源唯一效果主归属；执行后改归属不能再执行。 |
| 7 | 同批四条消息可同时表达部分相关独立完成与仅观察待处理 | 协议替代 | 不再以 steered/observedRequestIds/全群顺序作为提交门禁；Topic exact batch、独立 A/B、pending routing-required、同 Topic revision stale、失败日志定时恢复与精确重试分别覆盖。旧“阻塞其他消息”断言与本次目标相反，不保留。 |
| 8 | 一个Decision可把历史与当前消息多对多关联到不同Task | 数据模型替代 | Task 仅 topicRefs；runtime 的任务摘要/叶子固定版本读取、topic-runtime 的分页/跨群/越界、topic-store 的多引用与 CAS 覆盖。原 sourceMessageIds/messageHistory 多对多正文副本删除。 |
| 9 | 明确@其他同事的消息不能建Task，后续引用并指向Agent后才允许转交 | 保留并加强 | Topic 来源授权反例；现有 task-context/cancel/reopen 同样拒绝指向他人，明确引用转交正例通过。 |
| 10 | 群消息撤销立即中断误建叶子且不等待Task串行队列或dispose | 保留并加强 | Runtime FIFO 取消、启动期间取消、共享主 Topic 批量取消两个不同 Task；迟到 create 无 Goal/输入且不复活。 |
| 11 | 不影响当前回复的请求只观察不消费并在回复提交后继续处理 | 协议替代 | 不再以 steered/observedRequestIds/全群顺序作为提交门禁；Topic exact batch、独立 A/B、pending routing-required、同 Topic revision stale、失败日志定时恢复与精确重试分别覆盖。旧“阻塞其他消息”断言与本次目标相反，不保留。 |
| 12 | 单请求含回复时submission自身即完成观察并引用当前入站消息 | 保留 | Runtime 重复入站可靠回复一次；缺稳定发送人 ID 不构造 replyTo/at 参数。 |
| 13 | 回复遗漏其他已Steer请求时返回stale且零副作用，合并新消息后只发送重新生成的回复 | 协议替代 | 不再以 steered/observedRequestIds/全群顺序作为提交门禁；Topic exact batch、独立 A/B、pending routing-required、同 Topic revision stale、失败日志定时恢复与精确重试分别覆盖。旧“阻塞其他消息”断言与本次目标相反，不保留。 |
| 14 | 入站消息缺少稳定发送人ID时普通回复不伪造引用参数 | 保留 | Runtime 重复入站可靠回复一次；缺稳定发送人 ID 不构造 replyTo/at 参数。 |
| 15 | Decision claim到可靠Outbox之间阻止同群新Steer越过回复门禁 | 协议替代 | 不再以 steered/observedRequestIds/全群顺序作为提交门禁；Topic exact batch、独立 A/B、pending routing-required、同 Topic revision stale、失败日志定时恢复与精确重试分别覆盖。旧“阻塞其他消息”断言与本次目标相反，不保留。 |
| 16 | Task动作缺少确认时保持pending且补回复后先写Outbox再创建Task | 保留并加强 | 全部 Task action 共用确认→可靠 Outbox→操作日志；schema 拒绝无 reply 动作；Outbox 返回 reply-busy 时零 Task 副作用；Web append/reopen 原子意图及相同请求重试。 |
| 17 | 已有Task重开和追加上下文都在确认Outbox之后执行 | 保留并加强 | 全部 Task action 共用确认→可靠 Outbox→操作日志；schema 拒绝无 reply 动作；Outbox 返回 reply-busy 时零 Task 副作用；Web append/reopen 原子意图及相同请求重试。 |
| 18 | Decision可靠Outbox失败会隔离为提交失败并阻止同群后续消息越过 | 协议替代 | 不再以 steered/observedRequestIds/全群顺序作为提交门禁；Topic exact batch、独立 A/B、pending routing-required、同 Topic revision stale、失败日志定时恢复与精确重试分别覆盖。旧“阻塞其他消息”断言与本次目标相反，不保留。 |
| 19 | 历史decision-failed仍可精确重试且已完成消息拒绝重复重试 | 保留并加强 | Topic 精确 messageId 重试仅恢复其失败操作，自动重试到期无需新消息；已完成 operation 不重复执行。 |
| 20 | Runtime重启后自动恢复孤立steered并严格按群消息顺序放行 | 协议替代 | 不再以 steered/observedRequestIds/全群顺序作为提交门禁；Topic exact batch、独立 A/B、pending routing-required、同 Topic revision stale、失败日志定时恢复与精确重试分别覆盖。旧“阻塞其他消息”断言与本次目标相反，不保留。 |
| 21 | Runtime恢复Resident时清理已失效的内存请求信封并保留普通待办 | 保留 | Runtime 恢复清理旧协议与旧 Topic 请求 Inbox，但保留普通待办。 |
| 22 | 启动只迁移可证明尚无业务副作用的历史判断失败 | 迁移边界替代 | test/topic-migration.test.js 用显式迁移、dry-run、冲突拒绝、receipt 保留取代启动时猜测重试旧逐消息状态。 |
| 23 | Outbox已落库后监听器失败不会反向否定Decision提交 | 保留 | Runtime 监听器失败不回滚 Outbox；实时与缓冲监听器分别实跑。 |
| 24 | 缓冲Outbox监听器同步失败会被隔离并记录 | 保留 | Runtime 监听器失败不回滚 Outbox；实时与缓冲监听器分别实跑。 |
| 25 | 消息已被Decision领取后标记steered失败会结算工具并释放门禁 | 协议替代 | 不再以 steered/observedRequestIds/全群顺序作为提交门禁；Topic exact batch、独立 A/B、pending routing-required、同 Topic revision stale、失败日志定时恢复与精确重试分别覆盖。旧“阻塞其他消息”断言与本次目标相反，不保留。 |
| 26 | 关联复核合并的新消息标记steered失败时不会发送候选回复 | 协议替代 | 不再以 steered/observedRequestIds/全群顺序作为提交门禁；Topic exact batch、独立 A/B、pending routing-required、同 Topic revision stale、失败日志定时恢复与精确重试分别覆盖。旧“阻塞其他消息”断言与本次目标相反，不保留。 |
| 27 | 关闭Runtime会等待已领取的Decision可靠写入Outbox | 保留并加强 | Runtime 关闭等待已接受的可靠 Outbox 写入；live guard 拒绝关闭后的新工具/入站；Topic activeToolCalls 等待已进入提交的调用。 |
| 28 | 关闭Runtime会释放回复门禁中的新消息并等待已开始的可靠提交 | 保留并加强 | Runtime 关闭等待已接受的可靠 Outbox 写入；live guard 拒绝关闭后的新工具/入站；Topic activeToolCalls 等待已进入提交的调用。 |
| 29 | 群历史导入等待resident时不占群提交尾链 | 同步路径替代 | hydrateGroupHistory 现在同步 steer Topic 索引，不等待 Resident idle；屏障内导入转到新 Resident，已有导入事件进入 replacement seed。 |
| 30 | 退订等待resident停稳时不占群提交尾链 | 保留并收紧 | Runtime 退订屏障后导入拒绝旧 Resident且B仍可提交；存储失败保留Resident；Store拒绝删除有Task引用、未完成decision或pending Outbox的群。 |
| 31 | 确认回复落库后退订仍等待其动作提交并在同一Task临界区复核 | 保留并收紧 | Runtime 退订屏障后导入拒绝旧 Resident且B仍可提交；存储失败保留Resident；Store拒绝删除有Task引用、未完成decision或pending Outbox的群。 |
| 32 | 退订持久化失败时保留resident并允许再次退订清理 | 保留并收紧 | Runtime 退订屏障后导入拒绝旧 Resident且B仍可提交；存储失败保留Resident；Store拒绝删除有Task引用、未完成decision或pending Outbox的群。 |
| 33 | 无回复Decision不要求观察全部pending请求 | 协议替代 | 不再以 steered/observedRequestIds/全群顺序作为提交门禁；Topic exact batch、独立 A/B、pending routing-required、同 Topic revision stale、失败日志定时恢复与精确重试分别覆盖。旧“阻塞其他消息”断言与本次目标相反，不保留。 |
| 34 | 附件缺失转换出的effective reply同样对未提交pending执行观察门禁 | 协议替代 | 媒体缺失硬拦 Task 并反馈；其派生 reply 使用同一 Topic CAS/basis 门禁。删除 shared-关联复核及全群 observed 层。 |
| 35 | Decision工具对重复未知和非法结构执行全量预检且不部分提交 | 保留 | 严格 Zod + 原生 DSH schema；exact batch 漏项零修改、session跨群拒绝、重复Task目标拒绝；Store幂等/CAS独立测试。 |
| 36 | Decision请求ID不能跨群提交且失败不会消耗任一群pending | 保留 | 严格 Zod + 原生 DSH schema；exact batch 漏项零修改、session跨群拒绝、重复Task目标拒绝；Store幂等/CAS独立测试。 |
| 37 | Agent活动异常结束后用单次恢复Turn结算同群全部pending Decision | 协议替代 | 不再以 steered/observedRequestIds/全群顺序作为提交门禁；Topic exact batch、独立 A/B、pending routing-required、同 Topic revision stale、失败日志定时恢复与精确重试分别覆盖。旧“阻塞其他消息”断言与本次目标相反，不保留。 |
| 38 | 同一事项的新确认会先精确撤回旧确认再发送合并回复 | 渠道边界调整 | 先持久 replacement 意图；prepareOutbound 精确撤回已回读旧 ID 一次；未回读不允许实际新投递，保留恢复意图。旧“意图也不能落盘”不再成立。 |
| 39 | 相同引用消息ID但事项内容不同不会自动撤回历史确认 | 保留机制 | 候选不自动等于同事项；仅显式 replyReview.replaceOutboundIds 驱动撤回。同一引用ID不同事项专属反例、无关B候选过滤及精确撤回测试覆盖边界；不依据引用ID自动撤回。 |
| 40 | 旧确认尚未回读时替换请求失败关闭且不追加新回复 | 渠道边界调整 | 先持久 replacement 意图；prepareOutbound 精确撤回已回读旧 ID 一次；未回读不允许实际新投递，保留恢复意图。旧“意图也不能落盘”不再成立。 |
| 41 | 普通assistant文本和turn结束不能冒充Decision，停稳未提交会进入自动恢复 | 保留 | Runtime 普通 assistant 文本或 turn 结束不能替代 Topic 结构化提交；coordinator 未提交归类超时重发、旧请求迟到拒绝与已接受失败定时恢复均有实跑。 |
| 42 | 未提交判断自动重试期间阻塞后续消息并在成功后按序放行 | 协议替代 | 不再以 steered/observedRequestIds/全群顺序作为提交门禁；Topic exact batch、独立 A/B、pending routing-required、同 Topic revision stale、失败日志定时恢复与精确重试分别覆盖。旧“阻塞其他消息”断言与本次目标相反，不保留。 |
| 43 | 关联复核也使用独立Decision请求且不回退读取assistant文本 | 协议替代 | 不再以 steered/observedRequestIds/全群顺序作为提交门禁；Topic exact batch、独立 A/B、pending routing-required、同 Topic revision stale、失败日志定时恢复与精确重试分别覆盖。旧“阻塞其他消息”断言与本次目标相反，不保留。 |
| 44 | 同一Turn的多个关联复核都通过steer获得执行机会后再结算 | 协议替代 | 不再以 steered/observedRequestIds/全群顺序作为提交门禁；Topic exact batch、独立 A/B、pending routing-required、同 Topic revision stale、失败日志定时恢复与精确重试分别覆盖。旧“阻塞其他消息”断言与本次目标相反，不保留。 |
| 45 | 同群回复门禁不会阻塞其他群的Steer与Decision | 保留并加强 | Runtime 多群独立 + 同群慢 A leaf create 时 B Topic仍accepted/completed，超过旧跨群隔离要求。 |
| 46 | 关联复核可合并影响回复的新Steer并由外层Outbox统一提交 | 协议替代 | 不再以 steered/observedRequestIds/全群顺序作为提交门禁；Topic exact batch、独立 A/B、pending routing-required、同 Topic revision stale、失败日志定时恢复与精确重试分别覆盖。旧“阻塞其他消息”断言与本次目标相反，不保留。 |
| 47 | 关联复核继承shared来源附件异常且不能绕过回复观察门禁 | 协议替代 | 媒体缺失硬拦 Task 并反馈；其派生 reply 使用同一 Topic CAS/basis 门禁。删除 shared-关联复核及全群 observed 层。 |
| 48 | Task通知由模型从完整历史选择承接消息与多位参与人 | 固定来源替代 | 通知只从已接纳 Topic 版本选择真实参与人；Topic 通知 routing/recipient/旧Task版本反例，Runtime 原始身份与固定refs读回。 |
| 49 | Task通知存在历史回复候选时审阅缺失返回可重试结果 | 保留并加强 | Topic 通知候选读取/Task输入版本/Store原子preflight；Runtime同version resume或新waiting问题以result快照拒绝旧通知。 |
| 50 | Task通知在新Steer到达后拒绝旧候选并只可靠提交重生成回复 | 保留并加强 | Topic 通知候选读取/Task输入版本/Store原子preflight；Runtime同version resume或新waiting问题以result快照拒绝旧通知。 |
| 51 | Task通知生成不占用Task尾链且新Steer可先完成任务动作 | 保留并加强 | Runtime 完成状态先落盘返回，未回复Resident不阻止FIFO后续任务启动；慢leaf也不占其他Topic接纳队列。 |
| 52 | Task通知到可靠Outbox之间同样阻止新Steer越过门禁 | 保留并加强 | Topic 通知候选读取/Task输入版本/Store原子preflight；Runtime同version resume或新waiting问题以result快照拒绝旧通知。 |
| 53 | 首次完成通知Outbox失败后可按稳定结果键补发 | 保留并加强 | Runtime Outbox首失败相同request重试稳定结果key一次；resultFingerprint精确绑定等待问题版本。 |
| 54 | 完成通知补发跳过退订群并隔离异常resident且不饿死有效群 | 保留并收紧 | Runtime 同批坏Resident + 正常群 + 已退订空群；正常群独立落盘、坏群单独报告。现有Store禁止删除任何Task关联群，因此原孤儿Task退订fixture不再是合法API状态。 |
| 55 | 关闭Runtime会拒绝尚未提交的Task通知请求而不悬挂 | 保留并修复 | Runtime 未提交通知close不悬挂；已开始提交的通知Outbox必须等落盘。新增后发现并修复close提前关闭Store的真实回退。 |
| 56 | 关闭Runtime会等待已领取的Task通知可靠写入Outbox | 保留并修复 | Runtime 未提交通知close不悬挂；已开始提交的通知Outbox必须等落盘。新增后发现并修复close提前关闭Store的真实回退。 |
| 57 | Task通知尚在等待resident空闲时关闭Runtime不会在关闭后创建回复请求 | 等待层删除 | 通知不再等待Resident idle；屏障之后的请求等新Resident，关闭后的工具live拒绝。未提交通知close/进行中close各自实跑。 |
| 58 | 消息判断自动恢复状态会过滤重复事件并阻止后续消息越过 | 协议替代 | 不再以 steered/observedRequestIds/全群顺序作为提交门禁；Topic exact batch、独立 A/B、pending routing-required、同 Topic revision stale、失败日志定时恢复与精确重试分别覆盖。旧“阻塞其他消息”断言与本次目标相反，不保留。 |
| 59 | 已有群切换预设时沿用原 Session，新群先创建 dsh Session 再持久绑定 | 保留 | Runtime 新群原生Session先创建、重复订阅一次、坏Session保留绑定、cwd切换seed保留、原生默认模型配置、AbortSignal超时隔离。 |
| 60 | Resident 恢复失败时保留原 Session 绑定并进入降级状态 | 保留 | Runtime 新群原生Session先创建、重复订阅一次、坏Session保留绑定、cwd切换seed保留、原生默认模型配置、AbortSignal超时隔离。 |
| 61 | Agent工作区统一写入各群Session cwd，变更时保留历史并重建resident | 保留 | Runtime 新群原生Session先创建、重复订阅一次、坏Session保留绑定、cwd切换seed保留、原生默认模型配置、AbortSignal超时隔离。 |
| 62 | Agent工作区切换等待resident时不占Task尾链并在提交前复核新任务 | 保留 | Runtime 工作区等待不占Task提交队列；期间WebTask可建立，切换最终复核active Task拒绝且旧Resident/配置保留。 |
| 63 | 工作区切换等待尚未登记pending的Task通知完成后再替换resident | 保留 | Runtime 切换工作区等待已开始结果通知；通知Outbox落盘前不释放旧Resident。 |
| 64 | 工作区切换等待历史导入完成并把完整事件作为新resident seed | 保留 | Runtime 工作区屏障内历史导入与通知等待新Resident；先前导入事件进入新seed，旧Resident不收到新通知。 |
| 65 | 工作区切换屏障建立后到达的Task通知改用新resident | 保留 | Runtime 工作区屏障内历史导入与通知等待新Resident；先前导入事件进入新seed，旧Resident不收到新通知。 |
| 66 | 退订屏障建立后到达的历史导入不会继续操作旧resident | 保留并收紧 | Runtime 退订屏障后导入拒绝旧 Resident且B仍可提交；存储失败保留Resident；Store拒绝删除有Task引用、未完成decision或pending Outbox的群。 |
| 67 | 关闭Runtime与进行中的工作区切换按生命周期串行收口 | 保留 | Runtime close与工作区切换串行收口，旧/替换Resident各释放一次。 |
| 68 | Agent默认模型与推理深度通过dsh原生默认模型服务保存 | 保留 | Runtime 新群原生Session先创建、重复订阅一次、坏Session保留绑定、cwd切换seed保留、原生默认模型配置、AbortSignal超时隔离。 |
| 69 | 单个 resident Session 恢复超时被隔离且不阻塞其他群启动 | 保留 | Runtime 新群原生Session先创建、重复订阅一次、坏Session保留绑定、cwd切换seed保留、原生默认模型配置、AbortSignal超时隔离。 |
| 70 | Task 使用确定性独立 Agent 与原生 Goal，两个名额满后 FIFO 排队 | 保留并加强 | Runtime确定性独立Task/Goal/FIFO；重启复用Goal和稳定输入ID；Goal预算、两次重建、checkpoint审阅、版本/CAS失败Goal保持active。 |

## 本轮补回的高风险交错

- 慢A创建leaf期间B同群Topic完成；启动中的queued Task取消后不复活。
- 配置等待中新WebTask进入，最终复核拒绝切换；屏障之前与之后的通知分别留旧Resident/等待新Resident。
- 历史导入seed保留、退订后导入拒绝、关闭与切换串行释放。
- 通知正常群与坏群并发补发，坏群不饿死正常群；关闭等待已经开始的通知持久写入。
- 同Task批内重复动作拒绝；同共享来源对两个不同Task取消各一次；执行后的原事实改归属不重新产生任务。
- 同version下resume/re-wait改变result时旧通知失效；Goal状态只在Task原子写入成功后推进。

## 验证边界

本文件不把受控Agent当成真实模型理解能力的证明；语义归类质量、群内最终投递/撤回读回、生产迁移与部署分别见native E2E及交付记录。原测试39已补同一引用ID、不同事项、显式无replacement的反例；未提交模型归类停稳后定时重发也已实跑，并验证旧requestId不能迟到提交。旧全群等待顺序断言按新架构取消。
