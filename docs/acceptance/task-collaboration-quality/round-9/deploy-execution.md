# 第9轮本地部署前置核验

- 负责：`collaboration_eval`；实际停止、安装、启动与合并由 `root` 统一执行。
- 现场仅只读，不代表部署完成。未停止进程、运行安装、写入配置、登录 Claude、重发消息或修改业务账本；随后按统筹授权仅补运维检查器、其隔离测试和文档。
- 依据：`docs/ops/task-session-clean-start.md` 的“已初始化实例更新核验”；主检出有用户修改，部署准备和源码校验均在本 worktree 进行，不改变主检出。

## 当前结论

**首次检查拒绝停机部署：只读账本检查返回 `DEPLOY_NOT_DRAINED`。** 2026-10-22T11:05:34Z 快照中只有一个执行未排空：

| 字段 | 当前观察 |
| --- | --- |
| taskId | `task-5b7dc69ca056472c22bd60e4b34a4721` |
| executionId | `b0c2b118-540c-44d1-a34d-a43bbe076790` |
| sessionId | `task-execution-242b9d0b-a390-43bb-95b5-a01d13cfc20b` |
| 状态 | `running`，`drained=false`，`sessionBound=true`，inputVersion=2，leaseEpoch=2 |
| 其余观察 | 未排空 Task/群会话均 0；starting operation/notification 均 0；unknown operation/notification 均 0；Claude execution 为 0 |

等待原执行自然结束，再由统筹重新做完整 Check。不能为了部署直接取消业务、手改 drained/owner 或把这份快照当作后续仍静止的证明。未运行完整部署 `-Check`，因为最终合并双包尚未冻结且账本前置已经不满足；没有用现安装旧包假充最终候选。

按统筹要求在 11:09:24Z 只读复核，该原执行已自然 `succeeded/drained=true`，更新时间 11:07:04.768Z；原生日志最后 `turn/start` seq140、`turn/end` seq230。仅观察事件类型和身份，没有输出业务正文或干预执行。单条执行结束不能替代最终双包准备后的完整账本 Check。

## 实例与原包基线

| 项目 | 只读观察 |
| --- | --- |
| 当前 PID | `54892`；父 PID `83644`；创建时间 `2026-10-22T15:25:16.029887+08:00` |
| 端口 | 127.0.0.1:3080 与 127.0.0.1:18998 均由 PID 54892 监听 |
| 启动 | `D:/soft/node-v24.19.0/node.exe`，正式 `web-module-loader.cjs`，profile 原生 `bin.js web --no-open` |
| 计划任务 | `DSH Web Local`，Running，Enabled=true，RestartCount=0；Action/WorkingDirectory 与部署脚本精确合同相符 |
| profile | `D:/dsh_home/profiles/web/cordis.patch.yml`；SHA256 `74fe100c0019f5e4c76c06903fdb622b0af5696afc60ab38cbd252ce8f948499` |
| 宿主 | profile 的 file 依赖声明与已安装版本均 `0.2.1-rc.2`，不是历史 alpha 版本 |
| 数据与身份 | `D:/baibu-agent/.dsh/task-sessions.sqlite`，instanceId=`dsh-web-task-a5c08eb`，ingressEpoch=`2026-10-14T05:16:22.360Z`；不改数据库、初始化标记或身份 |
| 健康基线 | `status=degraded`，recoveryIssueCount=2，inboundProcessing=true，dwsBridge.healthy=true；两个 active 既有告警，不把端口/传输就绪说成全部健康 |
| 后端配置 | 旧安装 `GET /state/agent-config` 尚无 `executionBackend` 字段；不为本轮部署开启 Claude，不登录、不传 DSH 模型给 CLI |
| Assistant 原包 | `D:/dsh_home/packages/main-192e808/zzusp-dingtalk-dsh-assistant-2.1.0.tgz`；SHA256 `8575d657f718d7f37932845a875fef237bc791d01d3fc15272fb62adebb4c5d7` |
| Observer 原包 | `D:/dsh_home/packages/main-192e808/zzusp-dingtalk-dsh-observer-2.1.0.tgz`；SHA256 `39320b022157f4e65876d207758375412d0fb0978894dd3f340af74ab541a2dd` |

原包仅为当前安装来源和回退调查基线；已核实存在与摘要，没有复制备份或把原包重新安装。

## Check 路径审查

入口 `docs/acceptance/task-session-runtime-repair/scripts/deploy-task-session-native.ps1` SHA256 为 `e487532d8ce73c92c4ba5139bedeb2d6e176c95743ea05c7b75f4e13a4175b10`；检查器初查 SHA 为 `c428d9342d5c189a12325d75d60e3f47767079ea0e28ac4488354717c630f6cc`。本轮检查器修订与最终摘要见下节，部署时应采用修后版本。

- `-Check` 在第86行输出 `writes=0/signals=0` 后退出；创建证据目录/锁、禁用自启、发 CTRL+C、安装和启动都在此分支之后。
- 依赖的 `stop-web-console.ps1 -Check` 仅在独立隐藏 PowerShell 进程附加原控制台、枚举成员并脱离；发信号在 Check 提前退出之后。
- 账本检查器使用 `DatabaseSync(...,{readOnly:true})`，读取 quick_check/账本/原生日志，未更新数据；包检查只用 `tar -tf`/`tar -xOf` 读 stdout 并对比源码，不解压写入。
- Check 还调用当前 profile 原生 `plugin --help` 验证 CLI 依赖装配，抑制可能带凭据的完整正文。此处源码路径不执行 plugin add；本成员没有代跑它或声称最终完整 Check 已通过。
- 初查发现检查器把所有绑定 execution 当 DSH JSONL；现场 Claude execution=0 尚未触发，但会使新增后端之后的普通部署/桌面重启失败。统筹确认属于本 PR 直接引入的运维缺口，授权在合并前补齐，见下节。

## 运维检查器修复及证据

只修改既有 `inspect-quiescent-ledger.mjs` 与同目录测试。检查器保持标准库依赖，复制到 launchers 后可独立运行；原生分支不变，缺省后端仍为 DSH，未知后端拒绝。CLI 分支核对路径各级目录、journal 文件链接/类型/打开身份，原 session UUID、所有输入历史的连续版本与摘要/修订、单调租约、严格连续事件序号、每轮 binding 和最后 drained。缺日志或证据不符直接失败，不启动/恢复 CLI、不改账或重放 unknown。

生产 Store 允许 `continue` 在未领取队列上重复发生：输入版本递增、lease 保持，之后还可正式取消或因需求修订变为 stale。当前已排空且状态为 queued，或 cancelled/stale 并带 cancelRequested=true 时，只有最后 drained 与同 lease 的历史输入精确匹配、全部中间历史连续且没有新轮 start，才输出 `unstartedCliExecutions` 独立证明。历史已排空不等同于新输入已经执行；新 lease、缺历史、其他终态或伪取消继续拒绝。

| 证据 | 实际结果 |
| --- | --- |
| `deploy-cli-checker-first.log` | 首个混合 DSH/CLI 用例 FAIL；旧检查器错误查 CLI 的 `.dsh/sessions`，ENOENT，保留原始首错 |
| `deploy-cli-checker-final.log` | 初版48/48 PASS；仅覆盖相邻未启动续办，不冒称覆盖随后发现的真实 Store 连续续办/取消/修订 |
| `deploy-cli-store-fixture-1.log` | 2/3 PASS；stale 用例错误调用不存在的 `task.update`，属于测试夹具错误，首错保留；改用真实 `task.revise` |
| `deploy-cli-checker-verified.log` | 最终53/53 PASS、0 skip、11.65秒；包含真实 Store 连续2次 continue 后 queued/cancelled/stale、合法带点 taskId、混合后端、复制助手独立运行、坏身份/历史/序号/末态、hardlink/junction、unknown 原字节不变 |

最终检查器 SHA256 `2c2c0438a572319669a884fc880bcf810856103f831c4cf0f314c29d38e7715b`；测试 SHA256 `39e903a5125d458dee93c320809b94ba844fb13743aa6685de88ed05e0785693`。独立审阅者已核对53项日志及源码，并将 R7真实CLI的原 execution/operation body 与59条 journal 原字节复制到新隔离夹具进行只读检查，结果 verifiedSessions=1/drained=true；证据为 `checker-native-journal-replay-1.json`。原 R7整库的合成 Owner 未排空，仍正确拒绝 `DEPLOY_NOT_DRAINED`，没有修改原库来放行；此复验只证明执行日志合同，不替代整库停机检查。本成员没有同步已运行 launchers 或执行部署。

部署时必须按 runbook 同步 `scripts/restart-web.ps1` 与修后的检查器至 `D:/dsh_home/launchers/` 并逐一 SHA256 回读；旧 launchers 副本不会随插件安装自动更新。统筹已只读确认当前 restart 脚本差异仅为换行，无需改其逻辑。此同步与实际启停由统筹统一执行。

## 由统筹执行的精确步骤

先完成 PR 合并与合并结果验证，在本 worktree 基于最终合并源码产生并冻结持久双包。以下唯一占位是最终双包目录，必须换成实际已审阅路径；不能直接使用旧 `main-192e808` 包代替本轮源码，也不能从脏主检出打包。

```powershell
Set-Location 'D:/codex/worktrees/task-collaboration-quality/dingtalk-dsh-assistant'
$deployScript = 'docs/acceptance/task-session-runtime-repair/scripts/deploy-task-session-native.ps1'
$packageDirectory = 'D:/dsh_home/packages/main-<merged-short-sha>'
$assistantPackage = Join-Path $packageDirectory 'zzusp-dingtalk-dsh-assistant-2.1.0.tgz'
$observerPackage = Join-Path $packageDirectory 'zzusp-dingtalk-dsh-observer-2.1.0.tgz'
$deployArguments = @{
  Package = $assistantPackage
  ExpectedPackageSha256 = (Get-FileHash -LiteralPath $assistantPackage -Algorithm SHA256).Hash
  ObserverPackage = $observerPackage
  ExpectedObserverPackageSha256 = (Get-FileHash -LiteralPath $observerPackage -Algorithm SHA256).Hash
  ExpectedPid = 54892
  ExpectedProfileSha256 = '74fe100c0019f5e4c76c06903fdb622b0af5696afc60ab38cbd252ce8f948499'
  EvidenceDirectory = 'D:/codex/worktrees/task-collaboration-quality/dingtalk-dsh-assistant/docs/tmp/task-collaboration-quality-deploy-round-9'
}
& $deployScript @deployArguments -Check
if ($LASTEXITCODE -ne 0) { throw 'DEPLOY_CHECK_FAILED' }
```

该命令只在原执行已自然停稳、PID/profile 与冻结值仍相同、新证据目录不存在时可继续。PID/profile 漂移先调查当前来源并重新冻结参数，不静默采用变化。核对 Check 的 `checkOnly=true/writes=0/signals=0`、ledger 候选静止、包及控制台身份。正式执行必须沿同一冻结参数：

```powershell
& $deployScript @deployArguments
if ($LASTEXITCODE -ne 0) { throw 'DEPLOY_APPLY_FAILED_RETAIN_EVIDENCE' }
```

脚本通过原生 SIGINT disposal 等待旧进程、端口、owner 与子进程退出后才安装两个明确包；不复制历史、不修改 profile。脚本没有用于失败现场的 `-Resume`，不可凭空加参数；失败后按阶段读取 `failure.json` 再决定。

## 部署后的独立回读命令

不要仅采信脚本“installed=true”。同次正式执行结束后，由统筹独立读取以下内容；输出只挑非秘密字段。保持上面的冻结 `$deployArguments`，不重新按当前包计算“期望值”。

```powershell
$installedProfile = 'D:/dsh_home/profiles/web'
Get-NetTCPConnection -State Listen -LocalPort 3080,18998 |
  Select-Object LocalAddress,LocalPort,OwningProcess
$newOwner = @(Get-NetTCPConnection -State Listen -LocalPort 18998 |
  Select-Object -ExpandProperty OwningProcess -Unique)
if ($newOwner.Count -ne 1 -or $newOwner[0] -eq $deployArguments.ExpectedPid) { throw 'DEPLOY_NEW_PID_UNPROVEN' }
Get-CimInstance Win32_Process -Filter "ProcessId=$($newOwner[0])" |
  Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine
$health = Invoke-RestMethod http://127.0.0.1:18998/health -NoProxy -TimeoutSec 10
[pscustomobject]@{
  status = $health.status
  recoveryIssueCount = $health.recoveryIssueCount
  inboundProcessing = $health.inboundProcessing
  dwsBridgeHealthy = $health.dwsBridge.healthy
}
if ((Get-FileHash "$installedProfile/cordis.patch.yml" -Algorithm SHA256).Hash -ne $deployArguments.ExpectedProfileSha256) { throw 'DEPLOY_PROFILE_CHANGED' }
if ((Get-FileHash $deployArguments.Package -Algorithm SHA256).Hash -ne $deployArguments.ExpectedPackageSha256) { throw 'DEPLOY_PACKAGE_CHANGED' }
if ((Get-FileHash $deployArguments.ObserverPackage -Algorithm SHA256).Hash -ne $deployArguments.ExpectedObserverPackageSha256) { throw 'DEPLOY_OBSERVER_CHANGED' }
@('dingtalk-dsh-assistant','dingtalk-dsh-observer') | ForEach-Object {
  $manifest = Get-Content "$installedProfile/node_modules/@zzusp/$_/package.json" -Raw | ConvertFrom-Json
  [pscustomobject]@{name=$manifest.name;version=$manifest.version}
}
Get-ScheduledTask -TaskName 'DSH Web Local' |
  Select-Object State,@{n='Enabled';e={$_.Settings.Enabled}},@{n='RestartCount';e={$_.Settings.RestartCount}}
$config = Invoke-RestMethod http://127.0.0.1:18998/state/agent-config -NoProxy -TimeoutSec 10
[pscustomobject]@{executionBackend=$config.executionBackend}
```

结合脚本 `installed.json`、`observer-installed.json` 的源码/包/实际安装一致性结果核对本轮产物。精确安装流程已逐文件核验，不额外重复全量逐文件比较；若调查代码漂移才重新调用同一个 `inspect-quiescent-ledger.mjs package <tgz> <source> <installed>`。随后独立检查新看板执行后端选择/CLI 标签能力、原任务与原通知状态；不制造业务写入或为测试切到未登录 Claude。若恢复告警仍为2或其他非0值，如实报告与部署前基线差异，不称全部健康。

## 失败与回退边界

1. Check 不通过就停止部署阶段；当前明确阻塞为真实活动执行。不得杀业务进程、清 owner/unknown 或换库强行过关。
2. SIGINT 后未证明排空、安装失败等：保留原证据、库/初始化标记/会话日志、已发生效果、自启状态；不使用按进程名 taskkill，不自动反复启动。安装阶段失败应核对精确旧 PID 已退出、端口关闭及离线账本，再按同一宿主声明接续官方安装，不重发业务动作。
3. 包安装已完成而冷启动超时：脚本最多等双端口5分钟、传输1分钟；先读同一新 PID/端口/健康，若后来自然就绪补证即可，不重复安装或启动第二实例。
4. 当前原包可供调查，但不是无条件回退许可。若新代码已接纳新输入、产生 CLI 记录或外部效果，保留新增事实并先前向修复；旧包不理解的新后端/文档/协作状态不能靠旧数据快照消除。需要回退必须先经正式生命周期排空，核查旧包能理解当前持久状态后再统一执行。
5. 不需 Claude 登录就能部署本轮代码；默认 DSH 保持，真实 Claude 账号推理仍留后续授权执行。本轮不运行 CI，不修改 profile，不恢复业务为假验收。
