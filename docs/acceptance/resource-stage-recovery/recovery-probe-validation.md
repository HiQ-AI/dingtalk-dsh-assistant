# 公共恢复探针验证

SG2 已完成：`reply/check` 返回短参数 `managedCall`；当前受绑定的只读调查调用 `execution_restart_scope_probe`，Host 从原操作和原生记录重建计划，将完整 command 直接传给原生工具。末尾 LF、原摘要、原生 guard、操作记账、独立 job 及人工审计条件均保留。未改历史账本、未重放旧命令、未启动 PostgreSQL/Maven、未部署或外发。

## 验证结果

修订前的 `recovery-final-round-2.log`：106 个测试全部通过，0 skipped，8.7 秒。该真实结果保留，独立审阅后的当前结果见下方修订记录。覆盖文件：

- `test/native-restart-scope-probe.test.js`
- `test/native-restart-scope-runner-native.test.js`
- `test/dynamic-operation-readback.test.js`
- `test/native-restart-isolation.test.js`
- `test/native-restart-maintenance.test.js`
- `test/native-restart-http-drain.test.js`

实跑环境为 Windows 原生安装 profile `D:/dsh_home/profiles/web/package.json`。新的 native 测试用真实 DSH Agent/Session/Tools/Jobs/PowerShell，只将模型替换为确定调用顺序；保留目录、PID 文件、OOM 文本及 provider 副本均在新建临时夹具内。运行的是生产固定只读探针，没有启动业务进程。

实测包括：超过 6000 字 command 的原文、末尾 LF、真实原生调用参数、唯一 job/root、producer 终态、持久 Session 读回及 `readRestartScopeProbe` 取得凭证。删 LF、改 CRLF、缺子结果、缺外层结果、错 root、多 job、非 producer 终态均拒绝。摘要过期、command 注入、改原文和两类原生权限拒绝均未启动探针进程。缺 OOM 夹具导致真实 pwsh 退出码 1，受管外层明确失败；通用读回保留原操作身份、原生参数和结果。另有受管子工具错误的通用人工调查合同测试，错误摘要、调用身份和排空门禁不变，不推断无副作用。

## 独立审阅修订

独立审阅发现 P2：原生 `tools/post-execute` 可以在实际 job 成功完成后返回 block。此时账本已经接收策略变换前的结果，而复合工具仅保留最终策略错误，通用读回因结果摘要不同返回 null。隔离凭证一直正确拒绝，问题是失败调查缺少原账本对应的结果。已使用审阅者最小复现保存 `recovery-policy-block-before.log`（1 个用例失败），未覆盖此前 106 个通过结果。

修复后只在受管子调用活动期间捕获 Host 实际交给原账本的 `operationObservation`，另存原生管线最终 `nativeResult`。通用读回按原账本摘要精确匹配前者，并返回 `finalPolicyResult` 区分最终策略结论；不重算旧摘要、不转换失败状态、不伪造 tool/call。隔离证明对这两个结果层次及独立 producer 记录继续分别把关。

当前定向验证 `recovery-policy-block-after.log`：3 个受影响测试文件（scope-probe、scope-runner-native、dynamic-operation-readback），**61/61 PASS，0 skipped，20.5 秒**。新增真实正常 job 完成后 block、真实 exit code 1 后 block；两者均能按原 operation 身份与原摘要读回，最终策略错误保留，隔离凭证均为 null。另有原始工具错误再遭策略 block 的合同测试，确认原始失败与最终拒绝正文不同也不丢失原摘要。未扩大重跑无关用例。

## 保留的失败和边界

`recovery-probe-round-1.log` 至 `recovery-probe-round-10.log` 保留了实现阶段的首次失败及复验。其中自定义 Session event 方案在真实 profile 中因事件协议/跨安装私有类型失败，已移除；最终复用原生外层 `tool/call/result` 与原生 job，不添加自定义 Session event。原生 description 必填、前台 job 不返回 jobId、`completed` 仍可能为 exit code 1 等均以真实契约修正测试与实现，未弱化隔离标准。

扩大文件回归 `recovery-regression-round-1.log` 中既有的 32 轮上下文体积用例因默认 Windows TEMP 路径过长失败；该测试要求短 TEMP，与探针行为无关。未改它的阈值，也不把该轮记作全绿；最终按受影响的六个文件验证。

这些结果证明代码与原生隔离夹具路径，不代表历史真实 operation 已核销、生产业务已恢复或本地已部署。正式 operator 的 check/reply 与原人类审计来源仍是后续真实核销必需条件。
