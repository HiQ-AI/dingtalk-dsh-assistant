# 动态执行 provider 恢复机制

基线：main `1f10eea10aa26a1afc2e08ec9d0d842925b38bd8`，独立分支 `fix/provider-recovery-mechanism`。本次未提交、推送、PR、部署，未修改现场人工请求或启动业务任务。

## 已确认的现场链路

匿名现场取证确认同一动态 execution/session 的 v10 为 PI_AI_ERROR overload（HTTP 200），v11 的 pwsh/run_in_background=true 在工具体执行前遭插件 guard 拒绝，v12 为 PI_AI_ERROR 流内通用服务端处理错误（HTTP 200）。没有认证或配额不足证据。4 个执行均已排空；133 个操作为 131 成功、2 失败，无 queued/running/unknown。output=null 只表示本轮没有有效业务输出，不否定已有提交、部署或其他副作用。

原实现把动态 background 调用提前拦截，却已有 collectNativeJob 原会话归属校验、输出收集、终态和取消排空路径。provider 分类只接受两个精确文本，service 只落 code，模型决策负责续办，待人工请求又阻止任务调度。10 分钟进度巡检只观察 running 会话，阶段结果通知是结果唤醒，不是自动 provider 恢复准入。

## 最小修复

- 动态 native background 调用进入现有工具、原生权限/沙箱、operation 和 job 生命周期；传统工作流节点的限制保持原合同。没有 job 身份或 registry 不得假报后台成功，不替换原命令。
- 保存 phase、message、完整 providerError、恢复分类和原生 terminal 序号，成功业务输出优先于随后 provider error。
- SDK 明确的 SERVER/RATE_LIMIT/TIMEOUT/TRANSPORT/EMPTY_RESPONSE 属于有限恢复；AUTH/INVALID_CREDENTIAL/MISSING_CREDENTIAL、QUOTA/ACCOUNT_QUOTA、明确配置错误分别保留对应操作诊断。PI_AI_ERROR 仍默认不自动重试，仅接纳已验证 overload 或 HTTP200 Codex processing-error envelope。未知错误须先调查，不能据 EXECUTION_PROVIDER_FAILED 推断登录失效。
- 当前任务控制、需求/控制 revision、原生同会话本轮输入/租约/digest、最后 error 终态、原生句柄与 job 排空、无未决原操作同时满足，才允许同 execution/session 的续办。
- 控制账持久化 5/10/20 秒退避，至多三次短自动续办；重启不重置次数或时间。耗尽后保留技术等待，Host最多给三次10/30/60分钟的负责人复核唤醒。复核可如实wait而不重放执行，复核次数与冷续办次数分别累计；到期前禁止冷续办。三次复核后不再自动唤醒，真实新事件或输入仍可由负责人评估原会话受管续办，累计预算不重置。计时器只负责唤醒，账本时间负责准入；不依赖外部轮询配置。每次保留原失败结果、输入版本和成功 operation。成功提交后结束本轮恢复预算，失败预算耗尽保留诊断并只唤醒任务负责人一次。
- 通用暂态或未分类provider故障本身不能建立operator申请；仅明确凭据、额度、配置、其他真实执行故障或未决效果能提供对应操作依据。普通 requester 业务补充仍可持久提出；已有人工请求保持，不自动关闭。人工答复的 human.responded 必须由负责人消费后才准入恢复；若答复改变目标，负责人可原子替换待恢复输入并保留累计预算，不让旧目标抢先恢复。未知效果进入原对账路径，不能因 provider 恢复删除或重放。预算耗尽/未分类错误需要调查，真实凭据/额度/配置操作要有明确证据。
- 证据读取/匹配失败停止该 execution 自动恢复、保存原错误、持久化 recovery.blocked 并唤醒负责人；单坏记录不阻断其他任务。排空失败不会被标记成功，失败落账失败也会保留可见诊断。

## 协调范围

共享文件 `execution-session.js`：动态 background guard、provider failure 诊断；`task-session-service.js`：schedulePending、kickExecution、恢复计时器/关闭清理、容量释放、failure 落账；`task-session.js`：仅追加 provider/人工责任说明，不改工具投影或历史淘汰。`dynamic-task-store.js`：新增 Host-only retry-provider/provider-recovery-blocked 事务，result 恢复决策、人工/继续/claim 准入。新增 `execution-provider-failure.js` 分类模块。

没有修改 observer、execution-context.js、host-context.js 或业务项目。整体进度线程若修改同 store/service/task-session，应逐 hunk 合并，保留 task.progress 和 issue172 的投影修复；不能用整文件覆盖。

## 验证与边界

测试使用真实原生 Loop、Tools、JSONL、SQLite、shell/job/process/preset 生命周期，仅模型适配器脚本化；完整测试 profile 在 `/tmp/provider-recovery-native-profile`，没有安装或启动运行实例、没有模型请求/凭据修改。

新增测试覆盖：有界次数/退避时间/重启/幂等；无终态/外来终态/永久故障/未知效果/取消反例；真实服务同会话恢复与成功写入一次；真实显式 background registry 终态；单坏证据隔离。最终统一定向回归实际结果：390 个测试，389 通过、0 失败、1 Windows专属跳过；包含真实 npm tarball、完整原生服务/人工/后台和新增恢复测试。完整 TAP保存在工作区：`/workspace/shared/provider-recovery-final-tests-v2.tap`；Library交接包不包含日志。独立审查确认调度隔离、独立退避计时器、普通续办上下文、分类边界和人工答复竞态修复后，没有剩余阻塞性机制问题。

初期基线对照复现了四个既有失败。最终已修 provider-native 两项 legacy fixture：原自定义manager漏接当前真实Host runOwned写入所有权，模型调用前即TASK_SESSION_HOST_WRITER_REQUIRED；接回真实router/runOwned后保留全部原blocked/ack/身份/仅暂态恢复断言，true/false两例通过。progress-native两例 EXECUTION_PROGRESS_INPUT_MISMATCH由另一线程处理，本任务不修改、不计入通过集合。

真实外部 provider 可持续失败；本修复保证受控恢复与证据保留，不保证外部服务可靠性。已收到v12原生PI_AI_ERROR完整文本与HTTP200诊断；匿名fixture保留原文结构并替换请求标识，不把派生phase/status作为原始字段。分类、真实原生失败和同会话恢复三层回归通过；这些是云端证据复现，不代表现场任务已执行或恢复。现存人工请求不被本修复自动撤回。

统筹会话自身provider故障也采用持久有限预算：三次5/10/20秒续办和三次10/30/60分钟续办，仍失败则暂停自动请求，不制造人工事项。每次到期或真实新要求的一次准入均在task.claim事务内消费，普通运行时异常不能复用旧到期时间或版本差异热循环。实际新要求保留一次受管处理入口，次数不因lease、inputVersion或重启重置；真实成功决定结束本轮provider预算。
