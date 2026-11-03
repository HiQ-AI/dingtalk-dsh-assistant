# 第 8 轮：合并代码本地部署

日期：2026-11-03。用户追加授权“合并部署本地吧”；本轮只合并 #337、更新本机既有实例并做必要验收，不发布 npm/tag、不手动运行 CI、不运行付费模型或向钉钉发送测试消息。

## 结论与版本

- #337 已 MERGED，mergedAt=`2026-11-03T11:28:45Z`，合并提交 `4ae15476dd33128232ce3b647ef052a6bb351c3d`；部署包来自快进到该提交的隔离检出，生成客户端无差异。包源码、scripts、test 未改；本轮工作树只有部署记录增量，使用后续分支 `worktree-topic-routing-local-deploy`，不推旧 PR 分支。
- 按 `docs/ops/task-session-clean-start.md` 的已初始化升级合同和既有 `deploy-task-session-native.ps1` 执行双包安装。原生 SIGINT 后旧 PID 29252 与其捕获子进程退出，端口关闭、离线控制账排空；未强杀、未清库、未重建初始化身份、未备份历史副本。
- 新 PID 34072，创建时间 `2026-11-03T19:42:27.570308+08:00`，同时持有 3080、18998；独立回读旧 PID 不存在，健康 ok、DWS bridge healthy、入站处理与出站许可正常、恢复问题 0；计划任务仍启用。Observer 分页 ready（15 项任务、0 项待授权）。

## 产物与实例身份

| 包 | 版本 | SHA256 | 安装后检查 |
| --- | --- | --- | --- |
| Assistant | 2.3.0 | `1f7332296cf9d15bfb876a9f7bf96cae42353cb1fad892cb6b9a04b71cf901a0` | 95 个声明文件与包/冻结源码一致 |
| Observer | 2.3.0 | `953582d79c7247293329fed77a0771ab7f8f3a4bab39aa99666bd5e6a0f5273f` | 4 个声明文件与包/冻结源码一致 |

版本号与旧安装相同，不能只凭 2.3.0 声称更新。安装器把两个 tgz 放到 `D:/dsh_home/packages/by-sha256/<SHA256>/package.tgz`；独立核对持久 tgz SHA 与 profile 的命名 file: 依赖一致，不依赖临时工作树包。没有正式 Release 身份或 CI runId。

原 profile patch SHA256 保持 `1f2c3b27f47d2635c5c02c22c5965ec6c1d12b3516c86d77de7a8a4813e59f55`；数据库 birthtime、初始化标记 SHA 和 instanceId/initToken/ingressEpoch 联合摘要均与部署前一致，未记录原 token。新 PID 取得控制账，tasks/executions/groups 的未排空数均 0。既有 3 项 unknown operation、0 项 unknown notification 保持，不把 unknown 当成功或重放授权。旧 owner 留存字段不冒充已删除：离线证明为原 owner 进程已退出，启动后已独立确认新 owner 与新 PID 一致。

## 实跑与失败历史

1. `pnpm test:release-smoke` 首跑 14 项，9 pass / 5 fail。Bash 继承的 GNU tar 将 Windows 盘符当作远程地址；另有任务链超时。该次失败保留，未停正式实例。
2. PowerShell 7 使用 Windows 原生 bsdtar 完整复验：13 pass / 1 fail。包提取、源码及 import 校验、resident 启动和 health 均通过；个人技能任务链把冷打包和 Host 装配计入原 30 秒业务阈值，剩余业务未及时完成。不能据此声称全部通过，也没有放宽 timeout。
3. 先生成本次实际双包，再沿测试已有 `RELEASE_PACKAGE_DIRECTORY` 使用精确产物对剩余失败项复验：1/1，business 22115ms、cleanup 342ms、0 skip/cancel。原 Task 完成、三个执行均 succeeded/drained、queued/drained 必须等待及无工具错误等原断言全部保持，运行源码未修改。此结果是 13/14 后失败项复验，不写成一次完整 14/14。
4. 相同双包 SHA、旧 PID、profile SHA 参数先执行 `-Check`：`checkOnly=true,writes=0,signals=0,drained=true`，再正式执行。真实 signal 回执只证明发出 CTRL_C_EVENT；排空以独立旧进程/子进程/双端口/离线账本终态为准，不用 signal 内的 `drainVerified=false` 冒充已排空。
5. 安装后将现有 `test/topic-recall-search.test.js` 和 `test/topic-routing-hold-observer.test.js` 的运行时 import 改指已安装包，其余输入和断言不变，执行 `node --test --test-concurrency=1 <两个临时.mjs>`：7/7，0 fail/skip/cancel。覆盖多词排序/分页、旧整串查询、按页投影、引用优先及历史候选、待判防旧完成戳覆盖、hold 变更更新页索引、本地身份/显式范围确认/CAS。原测试 SHA 与替换说明保存在最终 JSON；临时副本不保留。
6. 直接请求新 resident 的待判入口，仅使用不存在的测试 ID 和非法输入：外部 Origin 返回 `403 TASK_LOCAL_IDENTITY_REQUIRED`，本地 Origin 的空 body 返回 `400 routing_hold_request_invalid`。两条均在实际业务更新调用前拒绝，未修改真实消息、Topic、Task 或发送消息。数据与版本摘要独立回读相等。

## 证据与复现

最终证据：`round-8/validation.json` 汇总实际包 SHA、原生退出/安装回执、前后身份摘要、独立健康/进程/真实 HTTP 回读、所有冒烟轮次计数与输出 SHA；`round-8/installed-functional-tests.log` 保留 7 项输出。检查最终文件、持久包和依赖后，清理本轮临时 tgz、测试副本及原始运行明细（后者含无关健康/群信息）；仅清理本轮创建资源，历史报告与 round-7 的实现证据保持。

复现安装包合同：从原提交读取两个现有测试，仅将 `../packages/dingtalk-dsh-assistant/` 的 import 前缀替换为 `file:///D:/dsh_home/profiles/web/node_modules/@zzusp/dingtalk-dsh-assistant/`，放在本仓 `docs/tmp/<本轮目录>/` 的 `.mjs` 中执行；其第三方依赖由本仓依赖树解析，产品模块由已安装包解析。此测试中的 HTTP service 为隔离 fixture，不冒充真实用户恢复；真实 resident 仅做上述无业务写入的拒绝验证。包重建命令沿 runbook 的 `pnpm --dir <package> pack --pack-destination <唯一目录>`；不得覆盖既有不可变缓存包。

## 未验与遗留

- 本轮不重跑全量或旧已通过组；固定版本摘要基线 FAIL、此前未完成的原生覆盖边界继续保留在矩阵，不因部署成功改绿。
- 脚本模型/隔离 fixture 证明框架合同，不证明真实模型语义准确率；独立人工金标、真实角色大候选/metadata 连续分页 E2E 仍未验。
- 本机部署与安全 smoke 完成；没有真实钉钉新消息 E2E，未运行付费模型或主动触发 CI。五个成员窗口保留。
