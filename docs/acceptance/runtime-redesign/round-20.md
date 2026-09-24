# 第20轮：C01—C13 部署前覆盖映射

日期：2026-09-24。范围：只读核对规范、当前测试断言与此前本轮实际运行记录；本次未运行测试、未修改实现、未操作运行实例。

## 结论及证据使用规则

C01—C13 尚不能整体判定通过。C05 的隔离调度场景有直接通过证据；其余多数是部分机制已验证，C04、C11、C12 缺少规范要求的完整场景。真实渠道、共同 provider 配额、固定到达负载及质量留出集不能由单元测试替代。

下表的“部分覆盖”表示列出的断言曾实际通过，不表示对应规范用例整体 PASS。“未覆盖”表示没有找到对应完整测试及实跑证据，不等于实现必然错误。本文件不更新 matrix.csv，不将历史测试存在性转换为新一轮 PASS。

### 可引用的实跑记录

- E1：本线程已实跑 `node --test test/message-ledger.test.js test/message-workflow.test.js test/workflow-service.test.js test/workflow-recovery.test.js test/workflow-entry.test.js test/dingtalk-dsh-assistant.test.js`，63/63 通过，0 失败。该轮早于后续 Web 操作新增用例。
- E2：I 上下文去重修改后实跑 `node --test test/message-workflow.test.js test/workflow-service.test.js`，29/29 通过，0 失败。包括保留原限制并合并新增限制的实际 Controller 修订；对应经过记录的失败及修复见 [round-15.md](round-15.md)。
- E3：Web 操作接线后实跑 `node --test test/workflow-service.test.js test/http.test.js test/execution-controller.test.js test/message-ledger.test.js test/workflow-recovery.test.js test/workflow-entry.test.js`，75/75 通过，0 失败。包含真实 SQLite、HTTP、Controller；不包含真实钉钉外发或真实模型分类。
- E4：[round-13.md](round-13.md) 记录三次真实 provider 分析链：前两次分别来源覆盖、参数合同失败；第三次可靠接收 96ms，S/R/I 为 4.251/2.558/2.769s，总链 13.875s。三个诊断样本不构成延迟分位数或负载验收。
- E5：[round-15.md](round-15.md) 记录全仓 804/804 与后续 806/806。此处只引用文档中已经记录的结果，不宣称本次重新运行，也不从总数推导下面未设计的场景已覆盖。

E1—E3 的输出来自本线程实际工具执行；行号是本次只读检查时的定位，后续修改可能移动。

## 逐项映射

| 用例 | 当前测试名称、位置和真实断言 | 已有实跑 | 完整场景结论与缺口 |
|---|---|---|---|
| C01 暂停媒体连接器，先 durable 接收 | `test/message-workflow.test.js:58`“历史原文增长不进入S；跨群未授权内容不进入manifest，远端引用不下载”：`downloads===0`、引用标记 missing。`:101`“材料等待不占模型槽，材料就绪只恢复原节点”：附件未齐不调用 A 的 R。接收代码 `message-workflow.js:18` 先 `message.receive` 落账再启动处理。 | E1；E4 另有96ms可靠接收样本 | **部分覆盖**。没有把真实媒体连接器挂起后同时断言接收返回、数据库独立读回及接收耗时上界；只读代码顺序不代替该实验。 |
| C02 A 材料暂停，B 独立；共享限制反例 | `test/message-workflow.test.js:101`“材料等待不占模型槽，材料就绪只恢复原节点”：先仅回复查B、A尚未调用R；材料就绪后查A，S仍一次。`:168`“执行材料未齐不接纳，ready事件只检查材料不重跑I”：未齐派发0，恢复派发2，I次数不增加。`test/workflow-service.test.js:94`“纯话题事实同库沉淀，后续任务读取原文并强制继承话题约束”检查约束进入任务。 | E1/E2/E3 | **部分覆盖**。独立材料已验证；未找到将同一受阻材料改成 A/B 共享限制并证明两个相关单元都受阻的配对反例。 |
| C03 无关历史扩100倍，相关否定/指代仍可见 | `test/message-workflow.test.js:58` 使用 `无关.repeat(100000)`，断言S投影长度小于1000、跨群未授权项不进manifest。`:207`“I投影去除Host目标副本，完整保留身份材料权限和约束”断言完整对象等价且字节减少。 | E1/E2 | **部分覆盖**。没有两组实际 provider 请求大小对照，也没有固定相关否定/指代来源随无关历史扩100倍仍被模型正确使用的语义样本。 |
| C04 一个Task两个别名、两个Task同名 | `test/message-workflow.test.js:38`“模型越界候选拒绝且不派发，记录可恢复失败”断言虚构candidate零派发、持久UNKNOWN_TARGET。候选投影见 `message-context.js` 的 `candidateCards`，保留稳定身份与判别字段。 | 邻接防护 E1/E2 | **完整场景未覆盖**。没有一Task双别名、同名双Task和相反动作不可合并的明确输入、身份选择与来源保留断言；不能用虚构candidate拒绝证明关联准确率。 |
| C05 R(A)暂停，I(B)可开始 | `test/message-workflow.test.js:23`“A关联等待时B独立接纳和回复；重复接收不重复派发”：Promise挂起A的R，释放前已经仅回复查B；释放后settled，重投不增加派发。B到达handler证明其I已完成。 | E1/E2 | **隔离场景 PASS**。使用可控 judge/handler 和真实SQLite，证明不按整条消息wait-all；不是生产provider调度延迟承诺。 |
| C06 同标题不同状态/时间，反证只回R | `test/message-ledger.test.js:74`“单元重关联不影响另一个单元，纠正额度耗尽撤权并待处理”：旧R完成拒绝、另单元仍可接纳、纠正超限attention。`test/message-workflow.test.js:115`“重拆保留已消费B的命令，A纠正后继续而不重复B”覆盖重拆而非relink。 | E1/E2/E3 | **部分覆盖**。账本局部relink已验证；未找到同标题状态/时间模型判别及I反证→R重跑、S计数不变的完整联调用例。重拆测试不能冒充局部relink测试。 |
| C07 I期间进度变化不失效，限制变化使旧结果失效 | `test/message-ledger.test.js:31`“纠正begin立即撤权，旧结果和旧命令都不能继续”：已领取I旧结果报MESSAGE_STALE；`:53`源屏障拒绝业务node领取。`test/message-workflow.test.js:88`“补充撤销源版本时迟到R结果不能接纳和派发”零派发。`test/workflow-service.test.js:213`运行中修订保持唯一Task，最终需求保留“禁止生产写入”并增加“新增格式要求”。 | E1/E2/E3 | **部分覆盖**。版本撤权/限制保留有实证；没有I在途时只追加无关进度且结果继续有效，与真正修改限制的成对测试。R在途反例不能替代I进度无效化范围验证。 |
| C08 外部连接器暂停，accept无外部I/O | `test/message-ledger.test.js:175`“话题归属和命令同事务接纳，跨群证据或归属冲突整次回滚”：验证同库原子接纳与回滚。`test/workflow-service.test.js:161`通知失败前Task已经执行完成。接纳调用见 `message-workflow.js:118`；ledger reducer为同步SQL。 | E1/E3 | **部分覆盖**。没有主动挂起通知/无关材料连接器并测量accept事务可完成、锁持有窗口内无外部I/O的仪器化反例。 |
| C09 业务环境/Agent启动暂停，查询取消独立 | `test/message-workflow.test.js:136`“慢独立动作不挡另一个事项八动作依赖链即时走完”：A handler挂起，B八动作先全部完成。`test/workflow-service.test.js:232`“新Task真实HTTP补充与取消同库幂等；无权/跨站/伪造输入不执行，暂停不恢复”：真实Controller暂停后补充/取消不走旧runtime，重投不重复。`test/workflow-recovery.test.js:9`坏任务不阻其它任务恢复及通知扫描。 | E1/E2/E3 | **部分覆盖**。独立控制/动作已有证据，但Web用例先已暂停业务；未直接挂起真实Agent启动或业务环境初始化并同时断言查询、取消仍在规定时限接纳。 |
| C10 provider失败与进程重启，有界续接且账不清零 | `test/message-workflow.test.js:47`“超时保留成功S，关闭重建运行器后不重新拆分”：15ms挂起模拟judge，关闭再建workflow，S总调用1、最终settled。`test/message-ledger.test.js:39`预算跨编辑与store关闭重开仍1；`:83`未知usage保留token预留；`:119`恢复超额持久attention、迟到命令不能覆盖unknown。 | E1/E2/E3 | **部分覆盖**。workflow对象重建及SQLite worker重开已验证；未覆盖真实provider故障后整个宿主进程退出/重启、成功S与R都复用的组合场景。 |
| C11 合批大项/未知慢项，拖累实测 | `test/message-workflow.test.js:158`“必要上下文超限进入可见attention，投影异常不形成静默pending恢复循环”验证容量拒绝；`:136`验证独立动作隔离。当前 `message-workflow.js:29`按stage/unit调用judge，无provider合批调度。 | 邻接防护 E1/E2 | **未覆盖**。没有合批大项隔离和未知同批慢项的真实计量。当前实现逐节点调用，不能以未启用合批推导规范合批性能验收通过。 |
| C12 固定到达持续/突发与工程共享provider | `test/workflow-recovery.test.js:16`“大量unknown通知不能挤掉新prepared；对账游标可到下一页”使用201条unknown+1prepared；`:24`旧活动Task不会被200条新终态挤出恢复。它们仅为索引/分页公平性。 | E3；E4单样本非负载 | **未覆盖**。没有固定到达率/突发、工程共享provider配额、容量内积压收敛、超载标记、失败/成本分母及尾延迟报告。不能从concurrency=2或上述201条记录推出容量结论。 |
| C13 渠道读回暂停，业务控制继续，状态区分 | `test/message-ledger.test.js:102`“通知ACK和读回分离，发送中崩溃进入unknown，禁止盲重发”：发送中重开库→unknown，再claim拒绝，readback后从未完成队列移除。`test/workflow-service.test.js:161`披露未许可零发送，ACK_LOST后unknown，重复flush不增加发送，独立readback后收口。 | E1/E3 | **部分覆盖**。可靠状态与不重发已验证；此账实现使用prepared/acknowledged/delivered名称。未找到真实渠道readback挂起期间继续执行查询/取消的联合时限测试，也未把正常ACK→acknowledged→delivered完整链与中断链成对覆盖。 |

## 部署解释边界

1. E4 只证明一个简单分析链成功，前两次失败保留；没有据此承诺每条群消息固定耗时。
2. C05 的受控调度 PASS 不扩大为C02共享限制、C09真实启动阻塞或C12负载性能 PASS。
3. Web/IM 已测的是澄清首终态与权限，不是生产SQL/Bytebase执行批准。当前缺少生产执行审批适配器，不能用这些测试宣称两端生产批准全链已支持。
4. 离线封存、Outbox对账、实际安装包、新进程、真实群读回和浏览器验收属于另行部署证据。本映射不证明已部署，也不改变任何旧账处置状态。
5. 若部署范围要求规范C01—C13全部达标，则本表所列缺口仍是未完成项；不能把“测试总数全绿”写成整份方案全验收。
