# 动态任务会话重构验证记录（2026-10-13）

## 基线与范围

- 在指定云端文件系统实施，分支 `refactor/task-session-runtime`。
- 已实际获取并从 `main` 的 `b2fb1acfeb9771a8ed9df7646b79133bd91e5430` 开始；其代码树与已合并 PR #169 的本地候选一致。
- Node.js `v24.19.0`，pnpm `11.25.0`，DSH `0.2.1-alpha.2`。
- 原有 `.test-runs/`、`docs/tmp/` 未清理、未纳入提交。
- 此记录证明源码与隔离测试结果；没有推送、合并、发布、部署、修改实际运行配置、迁移现场数据或给真实钉钉群发消息。

## 新架构的定向验收

冻结后的下列十个套件合跑 **91/91 通过，0 跳过**，约 5.2 秒：

```sh
node --test test/dynamic-task-store.test.js \
  test/dynamic-execution-session-native.test.js \
  test/task-session-persistence-native.test.js \
  test/task-session-service-native.test.js \
  test/task-session-http-integration.test.js \
  test/task-session-material-history.test.js \
  test/task-filesystem-boundary-native.test.js \
  test/task-notification-readback.test.js \
  test/group-reply-format.test.js \
  test/task-native-unknown-fence.test.js
```

| 边界 | 实际验证 |
| --- | --- |
| 原生端到端 | 实际 Loader、AgentLoop、Session、preset、文件/进程工具、SQLite、JSONL；群来源 → 唯一任务会话 → 双执行 → 结果唤醒 → 完成账/通知账 |
| 职责边界 | 任务会话继承的原生工具及迟注册工具均硬拒；执行会话禁止再次委派；任务不能凭执行成功自动完成 |
| 并发与容量 | 原生双读取真实重叠；任务/执行容量 `[1,1]`、`[1,2]`、`[2,1]`、`[2,3]`，每组两个任务、四执行全部收敛，不依赖恢复定时器补位 |
| 取消与版本竞态 | 真进程停止及排空；取消后迟到结果保留审计但不能完成任务；原任务/会话接受新版需求，旧结果不变成新证据 |
| 持久与故障窗口 | operation.start 在同一 SQLite 事务内拒绝 unknown 后才取锁/派发，prepare 与 start 间交错也不能绕过；明确拒派只撤销同 binding/key 的 prepared，不能撤销 starting/unknown；派发回执写失败回滚无孤儿；提交后丢 ACK 再开库保留同一执行；结果、wake、回执事务故障回滚；非正常独立进程退出后 unknown/锁仍在 |
| 外部效果 | unknown 不重复派发、不换参数绕过；可并发写工具“已写但丢回执”后的第二次工具体不执行；正常相同参数的多次原生观察使用真实 callId 区分 |
| 调度收敛 | 快速执行先于任务 wait 返回仍能继续；无 wake 的空闲任务不占槽；原生 setup/模型故障有界、退避；连续错误提交第 3 次停止，一次错误可纠正 |
| 实际工作目录/日志 | 任务/执行 cwd 和实际官方 JSONL 归本任务；真实持久化恢复；目录/日志缓存 symlink 逃逸被拒 |
| 材料与历史 | 真实文本/图片字节落 materials，缓存/摘要/身份检查；失败显式 unavailable；旧 SQL 及全部关联工件哈希前后不变，不产生新任务/阶段 |
| 文件边界 | 其他任务绝对路径、symlink、其他执行私有目录、Host 控制库（包含配置路径自身经目录 symlink 的真实目标）被拒；缺失/非普通读目标派发前失败，不虚构 unknown；本任务正常读写可用 |
| 通知 | 业务完成和送达分离；unknown 只读回不重发；强校验原群、引用、真实 mention、发送回执/幂等身份；同文无引用/假 mention/其他发送者不能认作送达 |
| HTTP/UI 接入 | 真实 loopback HTTP、CAS、来源身份、重复请求；新任务/执行数据投影；旧工作流/变量写入口明确 410 且不触发旧 runtime |
| Resident 装配 | 仅声明的原生依赖启动，不要求旧业务平台客户端；健康/群/配置读回；端口占用失败后 dispose，同库同端口可重启 |

模型回复由确定性脚本产生；DWS 通知由受控替身产生。另独立审查走过真实 Node 子进程 → DWS CLI 协议夹具，验证引用、mention、多行中文和幂等键的线缆参数，但 CLI 终点仍是夹具。这些都不能表述为真实模型或在线钉钉现场通过。

## 全量对比

本次从同一基线代码树另建隔离目录实跑：**3401 项，3273 通过、95 失败、33 跳过**。历史报告的 3275/93 不作为本轮基线。

最后广泛全量回归：**3458 项，3332 通过、93 失败、33 跳过**，约 356.8 秒。93 个失败名称全部命中本次实测基线，新增失败名称为 0；两个基线失败本轮未出现，不据此宣称已修复。失败名称和逐文件差异见[机器可读对比](task-session-runtime-failure-comparison.json)。

必须区分验证版本：该次广泛全量开始后，仅 `dynamic-task-store.js` 和 `test/dynamic-task-store.test.js` 增加最终原子 `operation.start` unknown 检查及确定性交错测试。因此不把这轮描述为最终提交的完整冻结全量。该轮结束后，又补齐“明确拒派但已 prepared”项的同 binding/key 撤销，避免原未知操作对账后仍被未派发项挂起；总计 5 个源码/测试文件相对广泛运行开始时有差异。前后 SHA-256 已在对比文件记录，其余 365 个源码校验未变。

最终差异已由上面 **91/91** 定向合跑覆盖；全部 370 个源码文件在该次定向运行前后哈希一致，见[最终源码清单](task-session-runtime-source-sha256.txt)。独立复核的真实 SQLite 交错反例现拒绝 `DYNAMIC_OPERATION_UNRESOLVED`，原子拒派的独立反例已通过；最终 prepared 清理还实际验证了工具体 0 次、只取消自身未派发项、原 unknown 保持，待其可信对账后原任务继续完成。没有将定向通过冒充最终全量全绿。

另一个未改动的旧父子进程取消测试曾在较早广泛回归失败。独立在原基线与候选各 30 次定向采样，各复现 1 次；失败瞬间 `/proc` 为 `State: Z`、`PPid: 1`、`FDSize: 0`，之后受控 PID 消失。属于已证实两边都存在的 Linux 僵尸回收时序不稳定，不是仍运行的任务；未修改或放宽其断言。最后这轮该项通过。

执行命令与 package.json 的 test 脚本一致：

```sh
node --test --test-concurrency=4 'test/*.test.js'
```

`pnpm test` 包装器触发自动安装，因当前宿主 `/home/agent/.local/share/pnpm` 不存在而在进入测试前退出；上面的 Node 命令只使用已安装依赖，未调整安装策略。

旧公开写入口的成功/权限测试已改为明确的 410、零旧 runtime 调用矩阵；原 CAS、幂等、审批交接、归档、材料重试和持久账逻辑继续以原 service/store 边界验证，没有为消除失败删除或跳过这些逻辑。

## 干净安装结果：未通过

在新的临时目录，仅复制工作区清单和锁文件，使用官方默认 `https://registry.npmjs.org/`，执行正常在线 `pnpm install --frozen-lockfile`。实际下载 189 个包后，完整供应链检查拒绝：

- `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`
- `resolve.exports@2.0.4` 发布时间 `2026-10-12T22:34:18.320Z`
- 本次实际 cutoff `2026-10-12T11:26:47.489Z`，对应有效等待窗口约 24 小时
- 该版本已在基线锁文件中，本次未替换它
- `pnpm config get minimumReleaseAge` / `minimum-release-age` 返回 undefined；不据此猜测策略配置来源

未放松供应链策略、改 registry、换版本或安排自动安装。离线尝试另因缺官方元数据 `ERR_PNPM_NO_OFFLINE_META` 失败。已安装依赖上的测试不能替代干净安装通过。

## 尚未验证与明确限制

- 云端 Chromium 正常启动因 socket 权限失败，正常审批升级又遇 bubblewrap 挂载故障。已停止尝试，没有禁用浏览器沙箱。React/HTTP/组件检查已做，真实浏览器视觉和交互未验。
- 当前没有真实 DWS 可执行文件/群发送闭环，钉钉 UI 渲染、现场引用/mention 元数据可读性未验。严格读回证据缺失时保留 unknown。
- Windows/PowerShell 现场没有验证；文档中的 JavaScript 检查/单项对账已在临时 SQLite 夹具执行，PowerShell 包装未执行。
- 每任务工作区是受管材料、日志和默认文件能力边界，不是任意授权 shell 的 OS 租户读沙箱。原生 shell 延续实际 preset/宿主权限；不注入任务私有凭据。
- 首版不支持后台/脱离执行任务。受管进程依赖实际 provider 的 terminate/waitForExit 合同；无法证明排空时不宣称完成。
- 原生日志适配器每次操作复核路径；无法把持有文件句柄后的外部特权 OS rename 竞态升级为系统隔离保证。
- 旧未决效果、未排空会话、pending 通知和全部旧 Owner native evidence 保守隔离。需要按[迁移 Runbook](../ops/task-session-migration.md)逐项核验，不能自动全部 resolve。
