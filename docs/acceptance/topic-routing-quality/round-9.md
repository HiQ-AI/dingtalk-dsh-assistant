# 第 9 轮：首次回复关键路径优化（阶段记录）

日期：2026-11-04

## 范围与结论

本轮承接 `worktree-first-reply-latency`，基线为新鲜 `origin/main` `350d8d7c`，部署证据回接提交 `21bb1df0`。本报告只汇总目前已回传的阶段实现、测试与审查证据；不能据此宣布首次回复延迟达标、真实模型质量达标或本轮整体通过。语义 oracle 已由 C 实际文本核验并经 D 只读审阅，结构化合同已实现并有核心250/250证据；最新Native仍有5项超时且被宿主内存保护中止，未经用户明确指示不得重启。原五例真实模型调用仍为0；真实评测配置待绑定，本轮最终冻结回归、语义及性能结论尚未完成。

文档更新反映目前稳定合同；短引用协议及最终guard/runner已静态收口；五例实际首包、检索与终态包长及真实 A/B 结论未测。代码与测试由各成员按 goal 单写，本轮报告由 Lead 最终整合。

## 合同变更

- 普通 `TopicDecision` 首次回复不强制先重写 Topic 摘要。未提交新摘要时不推进 `summaryRevision`；该版本号表示实际已汇总到的版本。后续判断应结合未汇总来源和已接纳决策增量，不得用旧摘要冒充最新内容。
- 独立 `task-facts` 事实通知仍要求 `summary`。其 handler 的 `preflight` 在群锁内、ledger 接纳前同步复验预装资料；资料变化拒绝为 `topic-stale`，漏读异常原样传播，不消费事实、不创建通知账。`test/topic-facts.test.js` 最新报告为 16/16、0 skip/cancel；D 对该冻结测试独立审查未发现可证实问题，未重跑。覆盖包含人工驱动真实 Session surface 与 SQLite/Store/handler/Coordinator 分页可见性，不代表完整 AgentLoop 或真实模型/钉钉。
- Task 决策视图保留固定版本的原始 request、来源、闭问答及审阅信息，只剔除明确的调度内部字段；超预算时保留有界补读，不宣称整份合同统一裁短。原生控制视图漂移由 `getTask` fixture 覆写模拟；`actions: []` 测试证明旧视图拒绝/补读门禁，不等同真实任务动作事务全链路验收。`taskDecisionView`/`readId` 登记本身不证明材料已呈现给模型；runtime已接入并纳入核心定向验证，但不能据此宣布最终Native或真实模型行为通过。
- A 提供的精简普通 scoped decision 协议采用 `{revision, decision}`，Unit 来源逐动作选择 `unitShortRef`；Topic、关联 Task 与回复候选短引用均请求内绑定，Host 展开后仍校验并持久化完整身份。基础上下文与读取工具保持 12 KiB 分页；仅唯一关联且完整视图和审阅可用时，决策首包可放宽至 64 KiB，按实际转义 UTF-8 计入指令；超限整体回退原读取调用，不截断。协议实现已冻结并纳入250/250；旧Native实测包长仅绑定其旧源码，五例最终首包及性能仍待实测，不将历史样例估算称为最终结果。

- 两级分诊只提交结构化业务意图，真正路由/普通决策仅保留必要业务补读与审阅；创建、唤醒、取消、中断、通知和送达回读继续由既有Host执行。当前SDK未发现原生responseFormat/toolChoice入口，不声称模型一定提交或只调用一次。Task Owner工具不退役。
- 路由新增请求内显式 `newTopics`，只共享标题及候选比较，每个target仍保留独立归属理由与来源；Host完整展开后走原规范校验和原子账。错误定位到具体字段，同revision内容漂移也按实际曝光快照拒绝；旧成功receipt不重判或重放。
- 两级可分别配置 `topicRouteModel`、`topicDecisionModel`，默认null完整继承原模型，独立保存/重置，仅影响新会话，不改变Owner或正式配置；尚未测试pearl/dew真实速度与质量。

## 阶段验证与审查

- D 最终实跑两级模型配置 Store 用例：`node --test --test-name-pattern='两级模型配置兼容旧记录' test/topic-store.test.js`，1 pass/0 fail/0 skip/cancel，501.2555 ms。最终 `store.js` blob `40f60a57bfebceca6748c5f2f59d838aa94a8bc7`、`topic-store.test.js` blob `d650a83dd28cde7612fa80688af65a89e9669307`；TAP 保存在 `round-9/topic-model-config.tap`，SHA256 `5378e1c50d76a1e456829b3832c79d9f37ef42fa83f6271e5eece0d240626fc5`。覆盖旧字段缺省、两级独立保存/重开、`null` 重置后重开、Owner 不变及 12 种非法持久记录加载拒绝（含空白 provider/model）。首跑失败源于测试误假设 `DomainFacility.update` 即时验证；源码表明 schema 在 open 时解析，修正测试以真实加载边界验证，产品校验未改。Provider/model/推理能力的 API 写前验证由 B 负责；此 Store 单例不代表完整配置页面验收。
- B 回报 API 定向测试通过；隔离 Chrome 390px 下运行真实 `ModelSelect`：分别选择 Terra/Luna，保存并刷新后两字段独立保留，重置路由配置为继承不影响决策模型或 Owner。隐藏测试 fixture 自身的回执元素后 `scrollWidth=390`；该横向滚动来自 fixture 回执，不是产品界面。B 报告 Native 两级模型定向测试 1/1、0 skip，cleanup `aborted=false`；真实 AgentLoop 请求分别使用 route-model、decision-model、owner-model，runtime `ee24eda1`、coordinator `e73fd79a`、test `53c59a3b`，八项内容 hash 前后匹配。该 Native 结果只绑定所列旧 blob，后续 A 改 runtime 后不自动覆盖新版本。配置/客户端组合 17 pass、1 profile 缺失 skip、0 fail；`test/web-client-build.test.js` 在 web profile 下 3/3、0 skip。浏览器使用合成 HTTP，不是生产验证；上述由成员及 Lead 回报，本会话未重跑。
- `test/coordination-model-native.test.js` 已在 `test/suite-map.json` 的 native 串行 lane；suite-map check 当前通过，343 个文件均映射、3 个历史项未变。
- D 的摘要事实早期测试曾出现 15/16 失败：自动摘要迁移遗漏 canonical 受理决定、以及纯 JSON 属性顺序差异导致 stale。修复后最新 `node --test test/topic-facts.test.js` 报告 16/16、0 skip/cancel、2904.8146 ms。runtime 前后 SHA 一致；handler 与测试版本由 D 回报。D 的三文件摘要变更早期定向测试为 5/5；该较早结果与后续 16/16 不累计。失败历史保留，不以修复结果覆盖。
- D 回报在 DSH Session surface、真实 SQLite、Store、handler 与 Coordinator 分页场景下，未读、末页未 visible、错误 `requestId` 等负例保持 pending 且无通知/outbox；全页正确 visible 后才接纳并产生单次内部账。该测试是人工驱动的真实 Session surface，不是完整 AgentLoop 或真实模型/钉钉验收。
- D 独立只读审查 B 的决策视图及 native 测试：对应冻结 blob 匹配，暂未发现可证实缺陷。此前 B 的相关 native 首轮 `31/34` 及三个业务超时 cleanup 正常作为阶段 FAIL 保留。B 后续在 `a116681f` 对整文件回归结果为 34/34、0 skip；相对 `9f83b2d7` 的精确增量仅为三处 `route context-required.nextCall` 补读、三处 `onCancel` 诊断和等义“不唤醒任务”提示断言，终态及超时未变。D 对该增量作只读审查，未发现可证实缺陷；D 未重跑，34/34 为 B 实跑报告，前后 runtime SHA=`1a0ce497`。
- D 对 A 的短协议/64 KiB 首包、结构比较、完整分片和只读路径作只读审查，暂未发现新增可证实缺陷；不替代 A 自报的 230 项结果或 B 的原生测试。A/B 当前交叉审查已回报收口，runtime 跨文件整合仍以最终冻结为准。
- B 提供的整合后 Native 整文件结果（HEAD `9cdec63893e7524e12d833861897fa11c1976542`）：34/34 PASS、0 skip、22.715s，三个 cleanup 均 `aborted=false`；首包 view 54,073 B、实际 body 58,435 B。哈希绑定：runtime `1a0ce497f1ebce87eb25dba2dc8560cc0daf4956`、coordinator `9cb010d6d0fc5bc36f5eca488c59553fee61fc51`、decision `f0c0950f5f53e68731273b47c67c866a704c7779`、store `91eda0d3470efe6253d028cf4ada4bb466309bf5`、topic-model `653bfc340620a778ee44c1285f47520b6532a3a9`、test `a116681f89a4897148869812d95802c2016e1e40`、shared fixture `7c935bfa38e7a78106efc28639644bc519c20991`；前后源码哈希一致。该结果由 B 实跑，D 只审测试脚本增量、未重跑。覆盖真实 task-context/Owner 及来源终态；summary 分页仍需读取，Task drift 由 fixture 注入，不扩大为全量生产语义验收。
- C 的历史数据提取脚本与隔离 runner/native 获得 D 的只读审查，审查绑定于指定旧版本；2/2 `new-task` 是 C 实跑，覆盖合成 Host 规范接纳、隔离通知 receipt 和 Owner 阻断。它不证明 Owner 业务完成、真实钉钉送达或所有 DWS 入口安全；后续追加代码不自动包含在旧审查结论中。随后 D 在有界评测隔离审查发现两项问题，C 修复后 D 只读复核：offline guard 曾可被候选 shortRef 绕过完整 ID 比较并读到合成详情；修复版本 `bf763dcb` 仅接受完整目标 ID/当前绑定，其余（含 shortRef）拒绝。review-only 来源曾只冻结 480 字符前缀、却播入今日 483 字符全文；修复版本 `f49c5c1a` 排除未证实尾部。`diff --check` 通过；D 未运行 Store/Native，C 旧版 19 消息探针不证明修后 scope。
- C 的五条例历史首次回复场景已由 C 将必要去标识消息/引用、Task 目标、requirements/acceptance/completion 限制及有效 request 授权段逐例写入语义 oracle；D 对该文件只读核对未发现曲解（`fixtures/first-reply-semantic-oracle.json`，SHA256 `632512f0`）。覆盖不含外部附件/现场实查与精确人员去重恢复。五例结论：773 为同事项状态答复；774 为同 Task 修复验证（UAT2）；778 为同 Task 清单 JSON 交付（有证据完整交付的等价例外）；780 为同 Task 生产只读查证；783 为同 Task 账号权限只读核查。773 的另一个导出权限修复已部署 UAT2，当前格式回导新修复尚未实施。其余四例优先 reopen 既有 completedTask，不扩写权限或生产动作。778/780 历史路径的错误已由 C 纠正，不是重复 requestId。随后复核发现 773/774 所关联 Topic revision 7 的历史状态不可证；其benchmark纯构造采用显式辅助关联Topic active前提，不称为历史恢复，也不把历史关联状态当已证。纯构造结论明确为 `bounded_related_status_unknown`，撤回此前将该构造记作 PASS 的表述；保留 strict 拒绝及缺 source 的 3/2 反例。C已完成显式benchmark层纯构造并经D静态审；strict仍拒绝未知status，benchmark采用统一active前提可以构造，但不是历史状态恢复、Host通过或语义PASS。其他具有同版本账证据的判断保留。C 后续增加四个最小构造语义反例，D 对 oracle blob `9860d275` 作静态语义核对；这不代表 Host 或模型行为已验证。完整金标仍未闭环，真实模型 A/B 不能以此代替。

- C最终可信guard `0e6cab14707e57046531f0923d76842c6459c17d` 已经D静态复核：只从唯一可信coordination seed/session、当前coordinator envelope及成功工具call/result登记映射，不从普通用户/嵌套业务原文建立绑定；合法当前shortRef可读取，跨请求及非目标拒绝。隐式Decision `{}`须绑定目标Topic，route `{}`保留原Host工具错误。C纯函数2/2，不是Host/Native或真实模型通过；此前过度拒绝合法shortRef的版本不作为公平A/B。
- 真实provider runner `1ce3e0200a394b41b465b2e75e8a2e6de622df9a` 已经D最终静态复审，C语法检查通过。统一当前harness `5f804d55`、分别从source加载产品；adapter使用实际模块导出，不注册ScriptedModel、不覆写maxTokens。验流错误落诊断并显式影响结构结果，操作匹配actionIndex；完整请求/stream/事件/工具、初始和最终规范Task及operation receipt在finally写入现有ignored私有桶，包含失败证据。结构接纳仍为 `semanticReview=pending`，exit2不作PASS，`realDelivery=false`；尚未执行真实配置check、Host或模型。
- 凭据SDK契约核对确认：pi-ai委托credentials.resolve，临时credentials-local自身仍会查继承进程环境及已有dotenv，不能据临时空store断言必不可用。C只读定位既有web profile唯一provider stanza，指定环境引用的非空布尔检查为false；最终合并有效配置、dotenv/managed和实际解析未核。因此当前为真实config待绑定、可解析性未验证，不是已证managed-store阻断；未复制正式配置、修改凭据或装正式可写服务。

## 整合后回归与阶段发现

#341 已合并：Lead 独立回读 merge commit `b2bc4070`，父提交为 `63ad6964` 与 `93e431a2`。合并前冲突解决状态不再是当前状态。

- `origin/main` 整合后，A 六文件定向单元回归由 Lead 直接读取：250/250 pass、0 fail/cancel/skip、17.1247 秒。`round-9/routing-core-unit-versions.txt` 绑定完整命令和 13 项 blob，测试前后一致；runtime `d2a04eea`、coordinator `ba9ff8d4`。文件 `routing-core-unit.tap` 保存输出。该分项通过不代表整体冻结回归完成。
- #341 新增用例 `anonymous missing-original-file wait preserves authorized repair progress, inspection and same-session recovery` 在整合树曾 0/1，business 阶段超时 30 秒；旧结果保留于 `round-9/main-delivery-integration.tap`。精确 `93e431a2` 独立 baseline 同用例 1/1，business 19,377 ms，见 `round-9/main-delivery-baseline.tap`。B 诊断发现测试脚本未读取 `summaryContext`；移除临时诊断后的四行单例适配c0044152版同用例1/1、business 9.511秒，是该读取合同的定向证据，不是产品修复或最终整文件回归；先前带诊断版本为11.622秒。该现象不应归类为上游既有失败；B已将读取移入公共fixture；最终human测试1701f51c还补了真实route context-required.nextCall，已获D静态复核但未运行，不能据此断言5项超时已修复。后续 B 原生执行因宿主内存不足被终止，Lead 读到的日志显示前四项参数化 human 用例及待实施批准事实追问共 5 项 business 30 秒失败、另 7 项通过且 cleanup 正常；没有完整文件摘要、task-topic/两级选型未开始、无结束 hash。失败不得归因于 OOM，不能称最终回归通过。宿主明确禁止擅自重启；当前全队 Native/Host/真实模型执行冻结，不转交其他成员绕过，待明确允许恢复后再续跑。

本次只读清单范围固定为 2026-11-04 Asia/Shanghai 14:00 起，至清单最后一条 G1 `seq817`、`receivedAt=17:41:26.915` 止，共 32 条消息、34 个 source 版本。此为该次清单，不代表此刻“14 点后”的实时总数；只读抓取墙钟时间未记录，标为未知。后续因果分析与修复验证限定此批，不重新滚动扩扫。

C/D 对下午 deferred 请求作脱敏汇总：26 条最终均提交 deferred 并 accepted；这只表示 deferred 接纳，不等同任务完成。下午账本无 Topic 决策、outbox 发信及 dynamic operation/notification 时间记录。纯表情忽略与职责范围外消息的 Resident `delivered` 投影不能当作发信送达。

- 附件读取出现 `dws_resource_read_failed:3`，且消息读取输出非 lossless JSON；模型称项目/页面未明。当前离线投影未复现 JSON 问题，非法值路径未证；外部资源读取失败与序列化问题分开保留为未收敛。不能据此断言原始引用缺失；首包消息对象无显式 quote 字段，其中一例有 `resourceRefs`。
- 两次 `context_get` 空参均被 `topic_id_required` 拒绝。
- 五条同请求路由尝试曾因缺 `topic_route_audit_reason_required` 被拒，模型后改为 deferred 并 accepted；没有成功创建 Task 的证据。新合同已实现显式共享定义和精确字段反馈并有核心测试，但未在该冻结业务批重放或验证真实模型纠正效果。
- 两例模型称近期原文读取被拒，D 已通过精确工具事件核实拒绝；首包 recent 已完整曝光相关近期正文，因此拒绝不证明背景缺失。
- 多例模型理由主要指向项目/服务、职责范围或历史候选同事故证据不足；资料是否确实缺少由逐例语义核验确认，不能把模型自述当成事实。原 Topic 续接有合理例；跨集询问不授权跨集复制，历史授权不等于下午有效完整合同。
- 一例 routed/pending 对应 entry revision 5，当前 Topic revision 8、processedRevision 4，revision 5 后无新 decision；无法仅据此证明 hold 原因或具体事故同一性。该条把当前事故 continuation 到不同日期旧事故，缺同一性证据。B 所报“下午无新 wake”对应另一组原 Task，不作为此 Topic 的证据。
- 26 条待判 hold 均未提供可缩窄的 scope，因此形成群级接纳屏障；不能据此断言“从未派发”。职责范围外案例的国内站是否等于广场证据不足，保持未收敛。18 条 route 精确会话路径及逐条理由已提供 D；当前 web profile 安装版本 2.3.0 及文件 hash 已核，16:40 前版本与当前 PID 实际加载字节未证实。

上述是脱敏读账与语义观察，不作最终根因归因；具体执行授权和下午新决策因果仍有缺口。旧 Native 34/34、`topic-facts` 16/16 不代替这批真实业务验收。不得将原文、真实 ID 或完整会话写入报告。

## 既有基线失败

Lead 在隔离的 `350d8d7c` 基线复跑固定摘要用例：

```powershell
node --test --test-name-pattern='固定版本不暴露后来摘要' <baseline-source>/test/topic-store.test.js
```

结果为 0 pass / 1 fail / 0 skip，4597.3474 ms；`test/topic-store.test.js:535` 注册、`:546` 断言，actual=`第一版`、expected 为空。Lead 回报 test、store、topic-model、lock 四文件 CRLF 归一化 SHA 与 `git show 350d8d7c` 完全匹配。此项是新鲜基线既有失败；本轮 candidate 尚未冻结，未复跑，不修改断言或历史报告。

## 恢复入口（尚未执行）

须先由用户明确允许恢复被内存保护中止后的执行；随后先定位5个Native超时，再进行有界五例Host/模型对照。以下为provider runner的零副作用预检入口，参数须绑定实际文件，不能用example配置报告通过；profile是该profile的package.json。773/774另传 `--related-decision-session` 和显式 `--benchmark-related-active`，严格历史helper仍保留拒绝。

```powershell
node docs/acceptance/topic-routing-quality/scripts/first-reply-provider.mjs --source="<源码根>" --profile="<profile的package.json>" --config="<已绑定配置JSON>" --resident="<只读Resident>" --decision-session="<决策会话JSONL>" --route-session="<路由会话JSONL>" --sequence=773 --related-decision-session="<关联决策会话JSONL>" --benchmark-related-active --check
```

真实调用在同一已通过预检的参数上去掉 `--check`，再显式添加 `--allow-paid --private-evidence="<唯一文件名.json>"`。完整业务证据只写 `docs/tmp/semantic-latency/`（已忽略，wx拒绝覆盖），不入库或公开报告；两侧使用同一有界初态、现有provider/model与统一harness。退出2只表示结构结果可供语义审阅，不能当五例PASS或实际提速。

## 未完成与限制

- C 已完成五例必要去标识文本的实际语义核验并形成 oracle（见阶段验证）；仍有未覆盖的附件/现场实查/精确人员去重恢复边界。原隔离实验缺少引用 Topic，且 guard 修复版保守拒绝了目标 shortRef，因此旧 candidate 不能作为公平性能对照；当前结构化合同、benchmark前提和可信映射已静态收口；五例真实模型A/B因宿主禁重启暂停，恢复后复用同五场景，不扩大付费矩阵。真实Host集成、有效配置绑定及完整流的语义审核未执行，不能宣称质量或安全自检通过。
- 当前由于宿主内存阻断，团队 Native/Host/真实模型执行被冻结，B 进程不得擅自重启或转交绕过；真实模型 A/B 为 0 次，新 PR 未创建，未 push、未部署。等待明确恢复授权，不把进程终止原因归因于五项 business 超时。
- A 核心协议及 64 KiB 首包实际长度有已绑定旧版的 B 整文件测试，整合后 A 定向单元 250/250；这些分项不等于当前最终冻结回归。C当前请求实际曝光映射及D边界静态审查已收口；最终包长测量、实际Host/模型与完整冻结源码回归仍未完成。测试映射涵盖两项新增测试及合理依赖闭包变化（包括 `task-model-config.js`），native 分片按既有排序重平衡；check 结果 343 个文件、historical 3、deleted 0。
- 生产首次回复建议目标为普通单事项已有 Task 的中位数不高于 60 秒；隔离 stub/模型测试不证明真实钉钉 deliveredAt 达标。无真实钉钉发送、生产状态修改、CI 或未经授权的付费评测。
- 固定摘要基线 FAIL、历史失败与未验边界继续保留；本轮不得标记整体通过。
