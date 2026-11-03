# Topic 路由质量改进

## 目标与授权

实施已确认的四项增量：语义评估闭环、历史 Topic 候选召回、持久化待判与恢复、当前决策合同去退役流程化。保留两级分诊与 Task Owner，不新增专家 Agent、向量库或固定类别平台，不按标题自动合并，不扩大用户授权。

用户于 2026-11-03 授权使用 cc-pool skill 启动 5 个 Claude 成员实施。主控 `dingtalk-dsh-assistant-db` 负责统筹、单写本文件、整合、独立核验和 PR；成员可直接沟通。交付到本地验证和 OPEN PR，不合并、不部署、不外发钉钉、不读取正式实例数据、不运行付费模型或 CI。真实模型质量门槛与预算另行确认，离线/脚本模型通过不宣称语义准确率达标。

## 工作区与当前合同

- 唯一实施目录：`D:/project/dingtalk-dsh-assistant/.claude/worktrees/topic-routing-quality`。
- 分支：`worktree-topic-routing-quality`；最新远端起点：`c80d42bf747cb950aa03ab7906194123bfc5683a`。
- 主仓在 `main`，其已有 AGENTS.md 修改及所有未跟踪文件不动。前次分析起点 c6722651 已过时，先复核最新源码。
- 所有成员沿用已核实的 bypassPermissions；不修改权限配置。Windows PowerShell 7；依赖 `pnpm install --frozen-lockfile`，不链接主检出 node_modules。正式环境文件不复制。
- 消息版本、来源完整覆盖、唯一效果归属、授权、CAS、恢复幂等必须保持；保留新主干的会话复用、执行路由监管和性能改进。
- `topic-runtime.js`、`decision.js`、`store.js` 等共享文件严格单一写者；不得交错修改。历史冻结函数不可顺手改动。

## 工作项与写入边界

| 工作项 | 负责人 | 写入范围 | 完成判据 |
| --- | --- | --- | --- |
| A 核心合同与待判状态 | routing-core | decision.js、topic-model.js、store.js、topic-runtime.js、task-topic-coordinator.js、coordination-sessions.js；关联源码需先协调 | 最新现状核对、决策快照、状态/屏障/恢复完整实现、定向测试 |
| B 候选召回及待判入口 | routing-recall | runtime召回块已交回A；独占observer-message-projection/observer-group-pages/http/observer web-client及新定向测试；新增必要既有Task原生fixture适配（不写C/D新测试） | 引用优先、有限多词检索，无自动合并；待判可见、鉴权恢复及受信完整scope接口 |
| C 评估与回归 | routing-eval | 本特性评估 fixtures/scripts（不写 goal）、新定向测试；修改现有测试先协调 | 隔离可运行评估入口、版本绑定、分组防泄漏、约120个有边界的场景；脚本结果与真实模型质量严格区分 |
| D 澄清通知与交叉审查 | routing-review | 独占dynamic-task-store.js/task-session-service.js的澄清链；其他增量只读审查 | 完成真实Host admission/发送前重验/冷恢复；通知由A/B审，D审A/B、B审C避免自审 |
| E 文档与证据 | routing-docs | README 和相关说明；本目录 round/matrix；spec 由 Lead 在设计确认后交权 | 按实际行为更新文档，整理成员测试证据，不擅自标全绿 |

五个独立交互会话已启动且通过原生消息通道接收分工。已独立核对 Claude 子进程：core/recall/eval=sonnet/high，review=opus/high，docs=haiku/low；全部显式 bypassPermissions。选择器/启动参数不证明服务端实际模型路由，窗口视觉尚未验证；不影响代码与通信核验。

## 关键设计边界

1. 评估使用带群职责、既有 Topic/Task 和原始来源的对话场景；不逐字比较动态标题。真实模型调用默认不运行，不新增 Anthropic SDK 替换本项目 DSH provider。
2. 召回复用 group_topic_list/context_get，检索改善须分别测候选召回与最终选择；新建依据只作可审计证据，不充当语义正确证明。
3. 待判须区别已忽略与已完成，不能进入无限自动重试；引用仅证明关联，不能证明影响范围封闭；只有 Host 可证明的完整目标或鉴权本地完整范围声明可窄化，未知取消等保守群级阻断。必须联动 pendingInput、接纳屏障、完成状态、通知去重、明确恢复触发与版本幂等。
4. 去除活跃流程目录/必填 workflow 字段时保留派发对象、交付、外部后续、Unit 来源；已接受操作账不重判或重放。旧草稿不能混用新合同。
5. 普通同事讨论不因不确定而自动追问；Agent 交办的澄清由 Host 沿既有通知账审阅/去重/发送，路由模型不增加副作用工具。

## 当前检查点与下一步

2026-11-03 授权内交付完成（本地定向验证 + OPEN PR，未合并/部署）：A/D核心实现与交叉审查已冻结。大引用完整冻结元数据续读、JSON转义预算、晚到引用共同恢复及准备失败清理均经定向断言/独立回接；真实role中大候选/元数据分页E2E仍未验。Lead最终核心10文件454项：450pass、1既有摘要FAIL、3原生环境skip；215源码/测试/锁文件前后hash无漂移，最终证据round-7/final-validation.json的core记录（原中间附件已按规则清理）。不把exit1称全绿。

第5轮四失败已定向修复：batch原30秒1/1，话题历史恢复原循环guard后原15秒3/3。第6轮新发现10失败（7 topic、3 web，含两cleanup超时），经B按真实拒绝调整测试模型与阶段提示断言，第7轮去诊断版原阈值10/10、0skip/cancel；web cleanup三项均正常。207文件前后SHA相同且Lead独立核对当前一致，最终两TAP及汇总hash见round-7/（前后重复绑定已合并到final-validation.json）；D对照三文件独立审查未发现可证实的原业务/界限断言削弱，3个Git blob与当前一致。产品核心未改，215核心绑定仍一致；不把脚本模型通过解释为真实模型反复旧提交不会饥饿。原skip通知3/3在第6轮补通过，已绿未变部分不重复。原生资源已由B交Lead，B无在途命令，测试文件冻结。

C数据现120条，按完整会话及已知构造族隔离为development104/holdout16，八类均覆盖；已证实同生成模板换实体的旧跨split场景集中development，新增有界反证重写由B只读抽审暂未发现其他明确模板泄漏/golden矛盾。人工语义标注与独立家族质量仍pending，不声称绝对无泄漏或模型质量达标。context-02在群级hold下先观察无关m3的Resident消息已routed、source.processingPending=true而未processingCompleted、无已接纳决策，hold/epoch不变，再精确引用恢复并最终结清；新版定向1/1通过。最终104/16同runner串行结果均failures=[]、streams0、cleanup全absent、modelQuality全not-measured；round-6三个evaluation JSON已由C和Lead独立回读，并完整汇入round-7/final-validation.json的evaluation；原中间附件清理，before==after且当前逐源码SHA一致，context观测epoch0→1和无关hold保留。eval单元最新7/7，尚不替代最终runner验证。

E README与矩阵已完成并冻结，最终写入权收回Lead；稳定合同已更新，已补实际评估CLI/分层边界，并生成、逐项审阅与check测试映射（335→341，仅6新增、0既有变化/删除、历史3不变；Lead已独立对照）；不改mixed历史分类。round-1至round-4保留；round-5/6失败报告保留，必要原始事实/测试记录及SHA已汇入round-7/final-validation.json，中间附件经独立核对后清理；round-7报告Lead单写、日志/前后绑定B提供并已独立核实，matrix仍E单写。

已核实边界：固定摘要在精确c80基线和冻结核心均同FAIL，原断言/冻结v8归档不改。最近fetch后HEAD..origin/main为0，远端仍c80d42bf。主仓已有文件不动。无CI、付费模型、正式数据、钉钉外发、合并或部署；五个成员窗口保留。

交付：代码提交 `b09ab5bc9e2151a217df20dfa7df10b1880c21a5`；PR [#337](https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/337) `feat(routing): 增加事项召回、待判恢复与分层评估`，`main ← worktree-topic-routing-quality`。Lead独立回读number/body/url/state/base/head/headOid/mergeable及ls-remote，确认OPEN、MERGEABLE、远端头与代码提交一致；随后只回填本目标文档，不改已验证源码。最终文档提交SHA以交付回复为准，不为文档包含自身SHA循环提交。

授权内工作已完成，不自动合并、部署、触发CI、付费评估或钉钉外发。固定摘要基线FAIL仍保留；独立人工金标、真实模型质量及真实角色内大候选/metadata分页E2E为明确未验边界，不冒充本轮通过。五个成员会话保留，均已交接其必要产物、无在途native任务；后续若获预算/环境授权，从上述已验证代码及final-validation.json接续，而不是重做本轮。

## 证据入口

- 前置快照：`docs/spec/topic-routing-quality-closure.md`，已保存并独立核实。
- 回归：本目录 `matrix.csv`、`round-N.md`，保留各轮报告，最终只保留必要证据。
- PR：[337，OPEN](https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/337)；代码/本地定向验证已交付，未合并/部署，真实模型未测。
