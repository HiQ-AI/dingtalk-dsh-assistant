# 第24轮：轻量首筛、常驻 Router 与直接 Task

日期：2026-11-07

## 结论与范围

SG8 当前授权范围内的实现、定向验证、独立审查和最终三包 smoke 已完成；Git 提交及新 PR 状态由交付回读确认。本轮不合并前置 #347，不部署、不触发 CI、不新增付费模型评测，也没有真实钉钉外发。此前历史质量/时延失败保留，不将本地隔离通过写成线上验收。

一级只决定静默、简答及是否交 Router，消息版本直接关联 Task；每个真实群/私聊有逻辑常驻 Router，安排与依赖持久化，空闲换新物理上下文继续使用现有 DSH。历史 Topic/Unit 只保留旧证据，不创建新的运行时 Topic 中间层。群通知多人、可选引用、atAll 和私聊限制、来源授权、跨群隔离及 unknown 不重发合同保留。

## 源码与版本绑定

测试时为 `worktree-resident-router-direct-tasks` 的未提交工作树，起点 `14ad11aa7c7ba2f0c4082ecc65bfd81cfa5b2a2f`；本轮 fetch 后 `origin/main=c0cdff0123d7a5d6d245b964295926a5a8b1dd1c`，HEAD 相对其 4 ahead/0 behind。前置 #347 本轮回读 OPEN、mergedAt=null；本轮另建 PR，不续推其分支。

最终产品/夹具：
- `conversation-router.js`：`b31df735ebdd4e1e31ad29af0804e1cdaa9d6c6c`。
- `conversation-router-session.js`：`f838eff3e3f0c2af3c397d6d4af5836caf3290ec`。
- `task-session-service.js`：`15ea0896181941537aa39012fff084a8702d2d28`。
- `test/fixtures/task-session-native-host.js`：`9ae1c0e4289e2dc4b2b6c960b8ea87f525feb082`。
- 最终 Topic Native 测试：`5d93242950c40dc21b0eb313af7bbe68aaa42429`；Service Native 测试：`7dfb958bc564c75b176184202b75e7d9fe91c983`。

最终154个源码/验证输入的逐文件SHA256、打包前/打包后/smoke后检查点、三个包的身份与关键运行输出SHA256集中在 `round-24/validation.json`。未拿HEAD冒充未提交源码；旧候选来源图独立保留于previousPackageCandidate，没有覆盖成新字节。

## 当前 Native 与恢复合同

- 完整 `task-topic-routing-native.test.js` 在测试blob `ad6065fac839d96d50311c62afcd64bdc601668b` 上实际 **43/43**，0 fail/cancel/skip，102484.4565ms，任务 `bw34kef89`。产品为最终b31/15ea/sessionsf838/fixture9ae，首尾一致。包括五模式真实进程退出恢复、同版本审阅CAS、首筛turn、Router active后到来源、旧冻结回复四态及Web九项。
- 随后仅补强来源时钟同步/基准：测试 `7dd348be7c0a68757f1d0871285ba70e3dc481ab` 定向 **1/1**，2066.4997ms，`b0i0ojr6h`。Owner仍受门闩阻塞时等精确来源processingCompleted，立即保存原at；无关输入、Owner放行和公开recover不改原at，Task1/Topic0/send0。
- 最后仅补强非锚正文反例：最终测试5d932定向 **1/1**，1862.5307ms，`bn7newejw`。B先真实ingest完成，本批新输入只有A；当前batch工具完整分页读取并准入B。reply.sourceId=A、正文泄漏B ID、伴合法new-task时精确拒绝GROUP_REPLY_INTERNAL_DETAILS，提交前后decision/Task/原生Outbox/Dynamic notification/send均0。同轮纠正后一个Task、一个decision、两application applied，按原notificationId回读delivered，实际send1。Lead/D均独立核源码和原输出。
- 上述是 **ad606完整43/43 + 7dd时钟增量1/1 + 5d932非锚增量1/1**，不声称最终5d932整文件重新运行。产品和共享夹具未再改；两处测试补强没有放宽原断言、时限或Host门禁。
- 最终Service真实shell preserve回归 **1/1**，14116.2661ms，`b8n1j4dem`；精确Web requestId唯一source，host/task-commit/materialize完成，preserve无old-drain；原execution、无取消、反馈收到/消费、Task完成和文件只执行一次均保持。business12718ms、cleanup514ms，未abort。
- 五模式冷恢复先前定向 **5/5**，`bsj2avd80`；后已包含于最终产品的完整43项。normal/stale/prepared/starting/two分别验证原ID送达、不发送陈旧输入、已准备旧版本退役、starting→unknown只回读，以及第一条已送达/第二条pending的恢复。two不等于两条同时pending；受控child exit(0)不等于优雅Host.close。
- 混合旧合同继续Release：ID4当前同version审阅过期拒绝及重读合法接纳，ID5不可变active与后续排队/continuity，ID18原冻结正文/引用/@与身份冲突保护。旧同version Topic重分类、旧batchRevision/steer、旧decision必须到completed/blocked的刺激已经退役，不声称等价；旧decision原对象及reconciliation告警保持。

## 相关阶段证据复用

这些是本任务早先阶段实际核过的结果，绑定各自源码版本；没有因最终producer局部修复机械重跑，也不拼成同一批次或最终源码全量结果。阶段入口保留于Goal当前检查点及validation运行索引。

- 原生关闭/恢复9/9，覆盖活动首筛/Router、创建中句柄和空闲换代；真正关闭先取消再释放，受控门闩不冒充另一完整SQLite Host。
- 成功receipt恢复5/5、失败清除双作者2/2、活跃v2输入1/1：按原ID/完整参数补账，缺receipt/不同作者/异参不放行，不重复reducer；必要settle/materialize仍完成。
- Web direct阶段9/9，附件/父通知/CAS6/6，Task上下文4/4；提醒与完成竞争分次通过，旧超时首因未收敛。Web-only A→B三项3/3（11005.89ms），手动recover前已自然完成，二次recover不重复，不伪造IM fact。
- Dynamic/通知投递/群通知219/219，真实DWS编译/Outbox/unknown回读路由3/3，桥接61/61，私聊传输119/119；隔离mock/Host验证，零真实外发。
- 模型API15/15、真实Domain持久化/继承1/1、背景导入1/1。背景导入不入首筛/Router，重复不覆盖当前来源；模型原生三项3/3是在脚本分页补齐后通过，不是真实中文模型质量评测。

## 历史守恒与映射

`node --test test/test-suite-contracts.test.js` 实际 **23/23**，10378.6568ms，`b05ij987a`。固定基线14ad：Service原42注册/53变体只归档ID12的3变体；Topic Native原36注册/45变体只归档IDs[6,7,10,11,12]的5注册/6变体。history保留原整句和helper，五个重复旧入口在当前Native中匹配0、history中各精确唯一；没有扩大历史范围。原三组202注册/220变体基线不变；bridge加新注册后仅刷新摘要仍拒绝，未知默认Release。

最终映射及release smoke内的映射合同均通过：**345文件各一次、historical5、deleted0**，两个当前Native文件仍release=true/native-0。不以仅更新映射或摘要跳过未复审变化。

## 最终三包与强制 smoke

重新实际打包 `b5bgwaefa`，三个manifest的name/version正确，104个非manifest包内文件逐字节等于当前源码；154输入在打包前、打包后、smoke后一致，三包SHA首尾一致。

| 实际包 | 字节 | SHA256 |
| --- | ---: | --- |
| dingtalk-dsh-assistant-2.3.0.tgz | 55335 | 1a0477391709446d6a57c2ffe0b76d8abcb124f100db65be29a355eb7ff44582 |
| zzusp-dingtalk-dsh-assistant-2.3.0.tgz | 550690 | c942d2c4818f12ee7df972b0f78ecacf4a610ea462df75c29b658af76c4c7299 |
| zzusp-dingtalk-dsh-observer-2.3.0.tgz | 62783 | d147a380d7e982e4a66280d65f024628ee2759118e53bca2718db3479dad961f |

显式DSH_NATIVE_TEST_PROFILE和RELEASE_PACKAGE_DIRECTORY，`pnpm test:release-smoke`实际 **14/14**，0 fail/cancel/skip，50755.8612ms，`b4l2lvsub`。真实解包包上的personal-skill task business26295ms、health business8178ms，cleanup593/184ms，均未abort；原30秒business未放宽。源码和包摘要首尾核验后才认定新候选通过，不复用旧Service16738候选的14/14。

再生成：Node24+及pnpm10.13.1，按锁文件准备隔离依赖/profile，在docs/tmp下新建空包目录，依次对根包、Assistant、Observer执行 `pnpm pack --pack-destination <绝对目录>`（子包使用 `pnpm --dir packages/<包目录> pack`）；显式上述两个环境变量后执行相同smoke。三包不入库，摘要和配方留存；重新生成属于新候选，不承诺gzip字节自动相同。

## 失败保留与未验证边界

- 首筛真实turn最初0/1（bg58esqfd），completedAt缺失。根因为direct无原生turn producer，Service旧onStage仅接旧session；新增真实session/event时间/seq并接既有recordMessageStage后定向1/1（b13x6eb2x），随后包含于完整43项。后到来源不回填原span；sourceId本身含messageVersion，不添加平行版本机制。
- 完整首次41/43（bwfd6213a）保留。时钟脚本错误给slow-clock另建Task，静默脚本未完整读取来源；修消费者且保持门禁/时限后定向2/2（b1lb80f2z），再真实完整43/43。静默仅证明Host收到脚本false/null的行为，不证明中文模型语义。
- 旧冻结四态两次0/4（bahi0lggx、borylv111）保留：先等退役旧decision终态，随后误读alert DTO id/code；改验证当前原notification及alertId/detail后4/4（b4qn8ycl0）。最早一轮测试树后来变化，不声称末尾hash绑定当前文件。
- 原Service16738旧候选smoke首次13/14（bw6m1aswe，mapping stale），修映射后14/14（bqsx8aqyw）；之后Web/首筛producer确有变化，旧候选失效，旧字节/失败及源码图保留于validation.previousPackageCandidate。更早打包后摘要脚本失败也保留，不追认成功。此次新包只读检查先遇转义与Windows默认GBK错误；没有改源码或重新打包，修检查后完整核验，原检查错误不算测试通过。
- 原旧协议、真实模型语义、生产首回≤60秒、真实钉钉外发和部署均未验证；相关历史FAIL/未收敛结论不删除。本地accepted、idle、execution成功、通知ACK均不当作业务完成或delivered。

## 证据保留

本报告、matrix.csv及round-24/validation.json集中保存结果、实际版本、失败边界和必要摘要；宿主原日志以任务ID/SHA索引，不复制完整日志、凭据、私有对话或用户绝对目录。最终记录独立回读后只清理本任务docs/tmp中的过期JSON、实际tgz等中间产物；PR正文文件在写GitHub并回读后清理。旧round报告、矩阵历史、其他会话文件及未知stackdump保留。
