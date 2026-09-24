# M1 正式底座本地验证

日期：2026-09-23。Windows、Node v24.19.0、pnpm 10.13.1；基线 61fee4c。本记录只包含合成用例，无现场任务正文、账号、凭据或生产 SQL。

## 控制账

`node --test test/execution-store.test.js` 的 14 项也纳入本轮完整回归。覆盖严格开库、身份/schema、SQLite WAL/FULL/FK、同 worker/跨进程独占、事务输出与后继 ready、Session 预留、输入屏障、取消排空、同 Task 唯一活动 Run、持久 claim 预算。

故障用例实际执行子进程 COMMIT 前 SIGKILL；另一子进程在真实 COMMIT 后丢弃 ACK，10 秒超时后写口封闭、重开读取原 receipt。SQLite `max_page_count` 限额产生真实 `SQLITE_FULL`，验证事务回滚，不等同于物理磁盘写满。队列超额请求被拒绝，已接纳请求完成。

## 效果与授权

`test/execution-effects.test.js`：16 项。Web/钉钉同请求首终态、指定 actor、先撤销 tombstone、开始时重验当前控制账、资源占用、未知作业不重派、旧代真实回执入账及正式 worker 同库事务验证均通过。没有真实渠道或外部写适配器。

## 节点编排

`node --test test/execution-controller.test.js`：10/10 PASS。schema 及显式 mapper 控制参数交接；无效产出不能让下游取得租约；补充输入先持久屏障、旧执行排空后整链换代；取消未排空保持 cancelling；重启优先处理已接纳 input/stop；相同创建 commandId 默认映射同一 runId。

独立反例发现“工件读取期间接纳停止后仍进入执行函数”，已在读取后重新检查 signal 和当前代际，并由测试证明 executor 调用次数为 0。20 个同内容并发写只发布一个完整工件；损坏工件读写均拒绝覆盖。

## 原生会话

`test/execution-session-native.test.js`：12 项。使用实际 AgentLoop、ToolRuntime、SessionStore、JSONL 持久服务，模型为脚本替身。验证 Session 身份事件、同 ID 续接、租约前进、缺失/冲突拒绝、显式工具清单和 schema、真实工具排空。

未知所有者的原生句柄不能被本适配器取消或接管；running 或 idle 但未 dispose 时，`assertDrained` 均拒绝确认，防止 Controller 虚报排空。

## 组合验证

`node --test test/execution-runtime-native.test.js`：4/4 PASS。

1. 等待后在另一进程重新打开原生 Session，使用原 ID、新 lease 完成下游。
2. 原生身份事件已 flush、控制账绑定前强杀进程；重启核对同一 Session 后完成。
3. 输出工件已写、结果事务提交前强杀进程；重启续接，不把孤立工件视为业务成功。
4. 实际 Cordis `apply` 注册 `execution` 服务，agent→code 输出 14；fiber dispose 后重新开同数据库，确认锁释放及成功状态保留。

原生组件是实物，LLM 是合成替身。本轮组合测试不等同于 CLI profile 安装、真实模型或业务 E2E。

## 完整回归

`pnpm test`：**688 tests / 688 pass / 0 fail / 0 skipped**，约 34.9 秒，包含新增 56 项及既有回归。`git diff --check` 通过。未修改 Web UI，未部署运行中的 resident。

## 初始化与包

在独立 `docs/tmp/execution-init-smoke/` 运行 `scripts/init-execution-store.mjs`：先 `--check`，返回 writes=0，随后 `Test-Path` 为 False；再 `--execute` 初始化。独立正常开库读回 schemaVersion=1、journalMode=wal、synchronous=2、foreignKeys=1、SQLite=3.53.3，文件大小 139264 字节。

`pnpm --filter @zzusp/dingtalk-dsh-assistant pack --pack-destination <绝对路径>` 成功。独立 `tar -tf` 读回 7 个 execution 模块（含 worker），`tar -xOf` 确认 `./execution` 导出与固定版本 dsh-tools 依赖。包仅作本地内容验证，不是新版本发布。

## 未验证边界

- 实际 Web/钉钉身份认证及业务审批投递；当前效果协议仅由受信 Host 内部调用。
- 任意 shell、生产操作、进程隔离与凭据/网络边界；pure/read 声明和工具白名单不构成 OS 沙箱。
- 真实业务消息迁移、通知、端到端耗时/token/p95、长期稳定性与生产部署。
- 物理断电、磁盘 I/O 故障、恶意替换锁文件；本轮进程强杀与原生 SQLite 限额不替代这些验证。

因此仅报告 M1 底座覆盖范围通过，不生成全目标全绿报告。
