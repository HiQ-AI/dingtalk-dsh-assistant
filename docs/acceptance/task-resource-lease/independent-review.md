# 执行资源行为独立审查

## 第一轮：修复前缺陷基线

- 范围：仅临时目录中的 SQLite 账本；通过公开 `store.command/query` 接口操作，不读写真实任务、不部署业务服务。
- 命令：`node --test test/dynamic-execution-resources.test.js`。
- 结果：初始 4 项全部 FAIL，退出码非零。失败均来自行为断言，不是环境或依赖异常。
- 同资源的第二次 `execution.claim` 没有拒绝，两个执行可同时运行。
- 派发 `['b', 'a', 'b']` 没有归一化，实际值仍有重复键。
- 安全排空后续办把资源由 `uat2` 改成 `uat3`，实际仍为 `uat2`。
- 相同续办 key 配合不同资源集合，未抛出 `DYNAMIC_DISPATCH_KEY_CONFLICT`，被错误视为原请求。

## 第二轮：修复后独立反证

命令仍为 `node --test test/dynamic-execution-resources.test.js`；扩展后 15 项中 14 PASS、1 FAIL。

- 已通过：多键原子获取、异键并行、结果与排空分离、unknown 只读续办与对账、后台 job、取消、重启、声明内操作共享资源、范围扩大拒绝、未启动操作取消、独立 operation 互斥、多个效果需全部排空、最后效果结清仍不能释放在运行的只读续办，以及 job 失败对账保留部分效果语义。
- 新发现并转交主代理：`task.blockers` 仍投影原始 execution，缺少实时 `resources`，与 `execution.get/list` 的等待状态不一致。已增加公开查询断言，失败为 `resources` 实际 `undefined`。
- 静态反证另发现：service 的 `task_delegate` 旧 receipt 快捷分支没有校验资源键，也没有返回实时资源状态；store 的同 key 冲突检查无法覆盖这个分支。转交主代理修复并在原生 service 测试验证。

## 第三轮：批量取消释放路径

同一命令运行 16 项，15 PASS、1 FAIL。`task.blockers` 的状态投影已修正，新增反证暴露另一处锁泄漏：执行已排空但尚有 prepared 操作时，`task.control` 把该操作改为 cancelled，未调用父执行释放逻辑，随后同资源执行仍收到 `DYNAMIC_RESOURCE_BUSY`。测试同时覆盖 cancelled、paused、task.revise 三种入口，要求终止全部未启动操作后解除已排空执行的占用。已转交主代理同步核对 service 的等待者唤醒。

## 第四轮：冻结候选后独立复验通过

主代理确认核心及测试冻结后，执行 `node --test test/dynamic-execution-resources.test.js`：**16 PASS、0 FAIL、0 SKIP，退出码 0**。运行前后独立计算下列文件 SHA256，全部一致，`candidateUnchanged=true`。

| 文件 | SHA256 |
|---|---|
| `packages/dingtalk-dsh-assistant/dynamic-task-store.js` | `C8AB05E16D42F0D4E4604BB7643BDAF5A9496EC574DCABB13C8D02DC2E0575A6` |
| `packages/dingtalk-dsh-assistant/task-session-service.js` | `E4F8B4CE1AD0DDAE9F6F7726D2B2ACA204599C9EA133C883056C597F0AE7C712` |
| `packages/dingtalk-dsh-assistant/execution-context.js` | `88BE01E077C5726C754236AE792CB59C631B838D73999AAC0DD9CD1F9DFF7851` |
| `test/dynamic-execution-resources.test.js` | `7FBE5B94A591621E3F68DB85D317CBB5F877F3D70890422E2B64EBDA67166DE5` |

三处独立审查发现均已在源码中修正：blockers 实时投影资源状态；service 旧 receipt 快捷路径比对资源合同并查询当前状态；任务控制/需求修订取消 prepared 操作时统一检查释放父执行，并调度等待者。前后两处已由本文件公开接口测试覆盖，service 快捷路径与调度由主代理原生 service 测试负责。

只读交叉审查还核对了健康检查报告的 31 个 loopback HTTP 用例、当前健康脚本调用指引与 GitHub 合并预检 helper。材料明确区分对象/可合并性、required checks、授权与业务验收；未将 helper 的 `approved` 写成整项合并许可。该部分为证据与实现审查，没有重复运行其他分工的测试，也没有访问 UAT。

本分工仅新增测试文件与本记录；未修改核心、业务代码或 skill，未提交、推送、部署或操作真实任务。以上是隔离账本行为证据，不代替安装后的运行验证。

## 第五轮：N+1 修正及最终定向结果独立回读

本轮证据来自主代理在最终候选上的实跑输出，本分工仅独立读取三份日志、当前批量投影实现并更新本记录，**没有重复运行测试**。

| 本轮日志 | 实际结果 | 覆盖边界 |
|---|---|---|
| [round-5-store.log](round-5-store.log) | 112 PASS、0 FAIL、0 SKIP | 包含本文件新增的全部 17 项资源行为回归，以及相关 ledger/readback 回归；17 项是 112 项的子集，不重复计数。 |
| [round-5-native.log](round-5-native.log) | 9 PASS、0 FAIL、0 SKIP | 原会话续办、unknown 通知不重发、真实进程取消排空、四档任务/执行容量、资源等待不占槽与排空提升，以及幂等回执资源校验/续办省略保留。 |
| [round-5-package.log](round-5-package.log) | 2 PASS、0 FAIL、0 SKIP | 实际 npm tarball 解包后运行个人 skill 任务，以及解包后的 resident 启动与健康。前项实际耗时 8542.114 ms，后项 5797.1671 ms。 |

### 查询放大问题与修正

定向静态反证发现，原 `executionView` 对每个执行调用 `heldKeys`，并对每个声明键查询 holder；`execution.list` 和 `task.blockers` 会逐项触发这些 SELECT，scheduler 每轮又读取两次全量 execution list。该结论来自源码调用关系，不声称已测得线上耗时。

主代理已改为 `executionViews`：每次公开读取只查询一份 `dynamic_resource_locks` 快照，在内存建立资源持有者与持有数量 Map，投影所有执行；不跨请求缓存，不在执行/资源循环内继续读锁表。`claim`、操作启动及恢复的实时不变量检查保留在变更路径中。

新增第 17 项使用临时真实 SQLite 账本建立 12 个执行、24 个声明键（6 个持有者与 6 个同键等待者），通过 `DatabaseSync.prototype.prepare` 的测试 mock 包装资源 SELECT 的 statement，统计实际 `all/get/iterate` 读取。该测试不匹配源码字符串，也不把仅准备语句的次数当作执行次数。

`round-5-store.log:17–18` 明确记录该项 PASS 及以下实际计数：

| 读取时点 | 公开查询 | 资源表 SELECT 次数 |
|---|---|---:|
| 初始持有/等待 | `execution.list` | 1 |
| 初始等待者 | `execution.get` | 1 |
| 初始任务阻塞项 | `task.blockers` | 1 |
| 原持有者完成并排空 | 带 taskId 的 `execution.list` | 1 |
| 原等待者取得资源 | `execution.get` | 1 |
| 新持有者与剩余阻塞项 | `task.blockers` | 1 |

六次公开读取同时断言实际 `held/waiting/available/released`、阻塞资源及持有者身份；释放并重新取得资源后得到新的持有者，证明本例没有复用过期快照。测试结束恢复 mock，派发、claim、释放等变更阶段不纳入查询计数。

在已声明资源的新增执行路径中，静态复核仍未发现“持部分资源再等待其他资源”的环：claim 在一个事务中取得全部键，操作只能使用父执行声明内资源并共享 holder，unknown 只读续办不能扩大资源集合。该结论不扩大为对既有未声明资源的操作模式或外部业务锁的全面死锁证明。

以上日志证明最终候选的定向行为与真实包内路径通过；正式安装后的进程、健康和业务运行状态由主代理另行核验，不由本记录推定完成。
