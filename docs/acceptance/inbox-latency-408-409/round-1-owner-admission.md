# Owner 接纳竞态独立实验

- 基线：`worktree-inbox-latency-408-409`，起点 `9dd585f0`；实验只使用临时目录中的数据库，不访问现场库、不重放真实消息。
- 入口：`docs/acceptance/inbox-latency-408-409/scripts/owner-admission-race.mjs`。在 PowerShell 中设置 `DSH_NATIVE_TEST_PROFILE` 指向已安装原生 profile 的 `package.json`；原竞态需显式 `--baseline`，该模式只复现旧基线，不用作 hold 修复回归。
- 实验使用真实 task-session-service、SQLite 和 native host；以可控桩替代 Owner 的 `run` 和 `cancel`。首次 Owner 提交 wait；第二次 `task.revise` 成功后，拦住首次带 taskId 的 execution.list，直到调度器启动新 Owner；新 Owner 保持阻塞。
- 输出：`{"result":"REPRODUCED","lease":2,"ownerRuns":2,"cancelObservedRun":2,"admissionSettledWhileNewOwnerBlocked":false}`；后台命令独立回读结果为 exit 0。释放新 Owner 后 `appendTaskContext` 才完成。
- 结论：该可控交错下，接纳等待了提交后启动的新 Owner；取消调用也发生在新 Owner 已启动之后。真实 Agent 是否被取消未在本实验验证，因为 cancel 使用了桩；真实取消实现会在调用时按 taskId 查找 active entry。该实验不证明 #408 实际耗时全部由此造成。
- 局限：本实验主动安排交错，不验证其现场发生频率；未验证慢旧 Owner 排空、重启恢复、材料错误及重复输入，需独立回归。

## 材料硬错误补充实验

- 当前 worktree 的首版 admission hold；运行同一脚本并传入 `--material-failure`。真实服务和 SQLite，Owner 为桩，所有数据位于一次性临时目录。
- 在 `task.revise` 账本提交后、调用返回前，将新增 source 的快照目标路径创建为目录；调用接纳后等待服务空闲。
- 输出 `{"result":"MATERIAL_FAILURE","error":"TASK_MATERIAL_PATH_INVALID","revision":2,"ownerRuns":1}`，进程退出码为 0。新需求版本已提交，Owner 只运行了初始回合，没有运行新回合。
- 优雅关闭服务及 SQLite、移除实验注入的空目录、重新打开同一临时数据并调用 recover：输出 `RECOVERED`，Owner 总运行数为 2，新增 source 快照实际存在且 taskId 正确。随后用相同 requestId 和显式参数重试：输出 `REPLAY`，revision 仍为 2、Owner 总运行数仍为 2，但返回 `web_task_request_identity_conflict`，并非成功幂等重放。
- `INPUT_COMPARISON` 实测首次与重试的 action、嵌套 topicRefs 内容相同而对象键顺序不同；`topic-model.js:28` 使用 `JSON.stringify` 计算 fingerprint，`store.js:991` 将其用于重复身份判断，因此相同请求因序列化键序变化发生冲突。
- 该结果不覆盖提交后即时崩溃、未排空旧回合或资源读取降级行为。

## 重试修复复验

- 基于工作区未提交的修复，仍运行 `--material-failure`，未重放现场消息。修后首次复验中业务输出成功，但旧实验脚本错误要求两次进入 `submitWebTaskInput`，导致断言失败、退出码 1；修改脚本改为断言成功重放且只提交一次后再次运行。
- 最终输出：`MATERIAL_FAILURE` 为 `TASK_MATERIAL_PATH_INVALID`、revision 2、ownerRuns 1；`RECOVERED` 为 ownerRuns 2，材料快照可读；`REPLAY` 为 error null、revision 2、ownerRuns 2、submissions 1；进程退出码 0。
- 修复后的重试成功且没有新增版本或 Owner，仍仅证明材料故障解除后的优雅重启，不覆盖即时崩溃或现场业务。

## Execution Claim 交错实验

- 同一脚本使用 `--claim-race`，在真实 execution.claim 请求进入代理、账本提交前设门闩；待 task.revise 提交后验证接纳尚未结束，释放门闩。输出 `CLAIM_RACE`：claims 1、claimError `DYNAMIC_EXECUTION_BUSY`、executionRuns 0、cancels 0、ownerRuns 2、revision 2，exit 0。
- 使用 `--claim-committed`，让真实 execution.claim 先提交、响应被门闩阻塞，再提交 task.revise；释放前接纳尚未结束，释放后输出 `CLAIM_COMMITTED`：claims 1、executionRuns 1、executionCurrent false、cancels 1、ownerRuns 2、revision 2，exit 0。
- 两种模式均使用真实服务和 SQLite，但 Owner/Execution 是受控桩；第二种的 current=false 来自真实账本，不能代替真实 Agent 的副作用核验；未覆盖崩溃。

## Held Queued 观察

- `--held-queued`：execution 并发上限为 1，一条 claim 在入口门闩占槽，另一条排队；hold 期间 revise 尚未提交。300ms 样本中 queued 2、execution.list 增量 0、claims 1；放开后旧 claim 报 `DYNAMIC_EXECUTION_BUSY`，executionRuns 0、revision 2；exit 0。
- 该样本并发槽已满，不能证明空槽下的 hold 屏障或长期无空转。`--held-open-slot` 两次以不同拦截位置尝试，均超时 `claim gate not entered`、exit 1，属于夹具前置门闩未建立，不能据此判断产品行为。
- 后改用双 delegate、并发上限 1；hold 建立、revise 未提交时释放第一条 claim，真实账本第一条 drained、第二条 queued，结束路径触发调度。300ms 观察 execution.list 增量 5、claims 保持 1；输出 `HELD_OPEN_SLOT`，ownerRuns 2、revision 2，exit 0。Owner 和 execution 为桩，未直接观测内部 inflight；该有限观察不能证明全局无空转。

## Owner Wake 跨入口

- `--owner-wake` 使用真实服务/SQLite 和 Owner 桩，以调用栈定位当前 `kickTask` 的 `wake.list` 查询，并在其返回前设门闩；hold 已建立且 revise 未提交时释放该门闩。
- 确认旧 track 已进入 finally 的 `wake.list` 时，`task.claim` 次数仍为 0；放开 revise 后输出 `OWNER_WAKE_HOLD`，claims 1、ownerRuns 1、revision 2，exit 0。实验的源码行号定位随代码移动需更新，不是现场验证。
