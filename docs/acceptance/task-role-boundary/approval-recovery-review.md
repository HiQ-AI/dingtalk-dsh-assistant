# 模板任务权限与恢复空档核对

结论：12 分 44.751 秒是原生审批等待；随后 3 分 35.628 秒是两回合之间的空档，不能计为模型思考或文件发送。发现旧统筹上下文失效后仍按旧版本尝试写技术阻塞的具体代码问题；该问题能解释一次不必要的错误退避，不能证明它解释了整个空档。

## 现场证据

仅只读查询原日志及 SQLite 精确任务键，没有重启、改权限、重新执行命令或发送消息。日期为 2026-10-28，以下时间均为 Asia/Shanghai。

原日志：`D:/baibu-agent/tasks/task-1543417ccb047c558066722d54cef580/.dsh/sessions/--D-baibu-agent-tasks-task-1543417ccb047c558066722d54cef580--/task-session-4a6cd0aa-b4dd-4413-8ad9-ee7aced646d1/session.v4.jsonl`。

| 时间 | 事实 | 证据 |
|---|---|---|
| 09:51:47、09:52:25 | 原终端命令均在沙箱准备时失败：`SetNamedSecurityInfoW failed (Win32 5): grantWrite(...)` | 日志行 60–61、80–81 |
| 09:52:39.411 → 10:05:24.162 | `approval/asked` → `allowed-once`，相差 764.751 秒 | 行 86–87 |
| 09:55:16.116 | 审批等待期间收到 UPR 类型补充，contextRevision 从 0 增至 1 | `dynamic_wakes` 中原 task.supplement；`task-drained:<taskId>:1` 精确回执 |
| 10:05:29.408 | 用户主动切换 permission 为 danger-full-access | 行 89–94，source.kind=user |
| 10:05:31.249 | ACL 脚本终态为 exit 0 | 行 95–96 |
| 10:05:31.679 | 第一回合以 blocked 结束 | 行 99 |
| 10:05:31.721 | 原任务排空，但仍 active；claimContextRevision=0，contextRevision=1 | `dynamic_receipts` 主键 `task-drained:task-1543417ccb047c558066722d54cef580:1` |
| 10:09:07.307 | 同一原会话开始第二回合，leaseEpoch=2、contextRevision=1 | 行 100–105；`task-bound:<taskId>:2` 回执 |

原 created 和 supplement 唤醒均由 lease 2 于 10:14:37.930 确认，未被 lease 1 吞掉。没有 `task-technical-block:<taskId>:1`、`wake-ack:<taskId>:1`、`task-provider-failure:<taskId>:1` 回执。审批之后没有新的重发身份或替身会话。

ACL 脚本的精确报告位于同任务 `docs/tmp/permission-recovery/acl-report-3b71a87594e049739efb206cafac4051.jsonl`：WRITE_OWNER 从 false 变 true、WRITE_DAC 保持 true，脚本报告 grant 已验证；但用户随后已经切到完全访问模式，原 confined 命令没有在原模式下复验。因此不能声称原沙箱故障已经验证修复，也不能为了本次取证替用户重新切权限。

## 本仓可确认的问题

已部署的 `task-session-service.js` 与工作分支基线中的相应逻辑一致：

1. `currentTask` 核对 binding.contextRevision 与当前任务版本。原回合的 0 与补充后的 1 不符。
2. `task-session.js` 在 pre-step 拒绝过期回合，使本轮以 blocked 结束；空结果最后返回 `no_submission`。
3. `kickTask` 对 `no_submission` 写 `task.wait`，却没有先排除已失效的 binding。`dynamic-task-store.js` 的 `currentTask` 会拒绝该写入，得到 `DYNAMIC_TASK_REVISION_STALE`。
4. `track` 将它按通用失败设置默认 5 秒 retryAfter，当前调度跳过；这属于正常补充触发换代被当成技术失败。

已在 `task-session-service.js` 的 `no_submission` 分支先调用 `currentTask(binding)`：绑定已失效则退出分支，走既有 `finally` 排空，保留原唤醒并由正常队列领取最新版本。有效绑定仍按既有路径处理，无新增重试入口。

## 本地修复验证

使用当前部署原生宿主（`DSH_NATIVE_TEST_PROFILE=D:/dsh_home/profiles/web/package.json`）、真实 Session 与 SQLite 夹具，模型输出为确定性测试夹具。新增用例在一次原生 `read` 成功后通过正式 `task.supplement` 注入补充，让下一 pre-step 停止旧回合；将技术重试间隔设为 60 秒，要求不调用恢复扫描、不等待冷却，仍从原队列接续。

| 轮次 | 结果与证据 |
|---|---|
| 修前反例 | 1 个用例 FAIL：出现 `DYNAMIC_TASK_REVISION_STALE`，任务停在 active，未自动接续。日志 `round-1/stale-context-before.log` |
| 首次修后 | 3 个用例中 2 PASS、1 FAIL。新增夹具误从模型精简投影读取未暴露的 contextRevision；不是修复有效性证据。失败日志保留在 `round-2/stale-context-after.log` |
| 修正夹具后 | 改从权威 `task.get` 查询 contextRevision，未放宽验收目标或超时；新用例及两个有效绑定 legacy no_submission 用例 3/3 PASS、0 skip。日志 `round-3/stale-context-after-2.log` |
| 整个相关测试文件 | `node --test test/task-session-provider-native.test.js`：13/13 PASS、0 skip，57.066 秒；覆盖正常空提交、provider 冷却、重启、恢复预算。日志 `round-3/provider-native-regression.log` |

新增用例同时断言：同一 session 从 lease 1 到 2、contextRevision=1、原补充被消费、原成功 read 只执行一次、全部原唤醒确认、没有技术失败告警、没有 providerRecovery、没有额外执行会话。代码已修，本地原生路径已验证；未部署，未重放历史任务。

## 反证与边界

- **模型故障**：第二回合 10:09:40 的一次 Connection error 晚于该空档，不能用它解释此前 216 秒。无 lease 1 provider-failure 回执。
- **丢失唤醒或重建任务**：原两个唤醒保留并由 lease 2 消费；任务和 session 身份未变，排除该解释。
- **权限审批本身一直未结束**：10:05:24 已批准、10:05:31 作业已结束，后续空档不属于待批时长。
- **宿主停机、全局排队或恢复扫描延迟**：缺少该窗口的进程生命周期及调度跨度。现场配置 recoveryIntervalMs=5000，`resident.js` 有周期恢复；通用失败的 5 秒退避不足以证明 216 秒。未收敛，不为此猜测修改权限、并发量或重试频率。

本次取证未证明端到端响应耗时改善，不能作为现场性能修复验收。
