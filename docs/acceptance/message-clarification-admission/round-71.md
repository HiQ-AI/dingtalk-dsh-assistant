# Round 71：检查进程排空与 Owner 继续

## 结论

定向验证 10/10 PASS，四个当前 v18 工程定义独立恢复摘要 4/4 匹配。SG20 只读预检确认原检查已无匹配存活进程，可由正式原生路径结算排空；本轮未部署、未写正式控制库，也未宣称业务验证成功。

## 根因和修复

原 `execution-controller.js` 的 recover 对 external-process 节点无条件要求排空证据，而检查适配器仅在内存持有子进程 PID。异常重启后节点变为 controller-restarted，旧 drained=false 永久留下，空效果账不能证明子进程退出。

现在 controller 在受信工程 verify 职责及 prepare-commit 的执行外围提供生命周期上下文；`execution-check-job.js` 的原生 spawn 包装持久记录 launching/PID/close 到本 Task 检查证据目录，绑定 Run/node/代次/lease/input。动态改名通过模板 revisionRoles 解析。旧 check.run、factory execute 和被散列的 registry 包装正文保持不变。

未来记录通过原 PID/出生时间及子孙树核验；launching 无 PID、身份不符或存活子孙均拒绝。历史节点通过原登记命令、同 Task 实际检查根、claim→recovery 窗口内候选目录及原生 OS 快照核验。未知身份只在命中该检查实际可执行文件时保留责任，不能把机器上任意外来 PowerShell 当作该 Task 的进程。

证明成立后使用既有 node.drained 事务，额外 CAS 原 inputDigest，保存可读 external-check-interrupted 证据。仍为 waiting，无成功输出，不派发旧配置；Owner 随后读取证据和现有能力选择继续或检查修订。原效果、成功前缀和代次不变。

## 实跑

```powershell
node --test --test-name-pattern '检查子进程真实|历史检查排空|外部检查重启只|Task流程副本修订|未排空' test/execution-pr.test.js test/execution-controller.test.js
node docs/tmp/check-active-registry-restore.mjs
node docs/tmp/preflight-sg20-process-drain.mjs
```

- 10/10：真实 Node 子进程启动/关闭、原 lease 日志、活子孙、缺 PID、跨 lease、历史命令/目录/未知同名进程、无关 shell 不拦截；原生 worker CAS 后仅排空不重跑；副本恢复与隔离回归。
- 日志：`docs/tmp/external-check-drain-final.log`；旧定义证明：`docs/tmp/active-registry-restore-proof.json`。
- 当前只读证明：`docs/tmp/sg20-process-drain-preflight.json`，`method=historical-command-process-snapshot`，`drained=true`，候选目录 1，匹配进程 0。

## 现场精确范围

SG20 原 Run `run-01a4fc72219b513a3f78e7cdb5be55699e448d6b63b97d3a65f8fcf60dc4d03f`，generation 6/revision 12，verify 节点 `b96e85bf-6b4c-4c19-b7ed-97bbce3a6ce8` lease 1。claim seq43195 为 02:28:20.150Z，recovery seq43221 为 03:00:39.217Z。唯一窗口内目录 verify-RGqd2n 已含依赖和 dist，故没有声称检查从未执行；退出结果已失，不能恢复为“成功”。

曾发现外来 powershell.exe 118528，但无本 Task 路径或登记命令关联；主代理另只读核实其 High integrityRID=12288，旧 Host98796/工具均 Medium8192；原配置没有 PowerShell/RunAs。该独立反证不变成通用 UAC 框架。历史证明不涵盖任意未登记外部服务；未决业务效果仍由原效果账阻挡。

## 旧插件升级排空闭环

新增原生排空 helper，并复用既有 `recover-quarantined-echo.ps1` 的 verification scope；统一部署入口仅在原完整 Check 因排空失败时尝试精确原节点核验。Check 零写预览不冒称完整预检成功；实际 enter→capture→witness→dispose→原生 node.drained→profile 原字节恢复→busy0→重新 Check/部署，未新增停机前 seal 权力。

- `node --test test/recover-verification-drain.test.js`：11/11 PASS，精确原节点、跨 Task/input/gen/revision/维护/其他效果/待消费输入/其他失败/前缀反例。
- `node --test --test-name-pattern '旧检查|不能占用' test/deploy-local.test.js`：3/3 PASS，真实入口隔离外部边界，Check 文件树零写、桥先于部署且 profile 字节不变、不能占用其他维护。
- 现场 native preview：maintenance inactive/revision520，匹配进程0、`eligibleRecovery=true, needsMaintenance=true, writes=0`，profile `3b5c…`、包 `22e53216…`。这里只读预览；没有声称排空或业务完成，正式执行由主部署流程记录。
- 原入口全文件 13/13 PASS（新增 3 例另行定向实跑）。正式统一 `deploy-local.ps1 -ArgumentsFile docs/tmp/conversation-led-deploy-arguments.json -Check` 也 exit0，明确 `coreCheckComplete=false, ready=false, eligibleRecovery=true, needsMaintenance=true, writes=0`；独立读取 profile SHA 仍 `3b5c562d4fea4ed95581698a90dbea4289d2b839dceb2c4dc68bbdbe34e628f6`，两个目标 manifest 均未创建。

## 现场回读发现及修复：工件根目录

正式排空后 Owner 原会话 turn26/seq15693 已选择登记的检查 v2，从 verify-candidate 重验；没有选择改业务代码迎合旧命令。但 seq15102/15786 返回排空工件 ENOENT，seq15694 因诊断未读拒绝，随后 block 被恢复可用规则拒绝，产生 TASK_OWNER_NO_DECISION。根因是本轮 helper 将 taskWorkspaceRoot 误传为 `D:/baibu-agent/tasks`，而原生 taskFilePath 自行追加 `/tasks`，工件落到重复 tasks 目录。不是 controller 的工作流修订拒绝。

已改两处参数为正式工作区根 `D:/baibu-agent`，新增 helper 所用参数经原生 artifacts.locate 解析与正式 Owner 路径相同的回归；12/12 PASS。12:19:45 使用原生 artifacts.read 验证原真实 proof 的 SHA、原节点身份与 drained=true，再用 artifacts.put 写入正确内容地址；引用及 SHA 均仍为 `485f7927e1b702d60c650844cb0205279c19c5fd72ae5b5cb8c2b209a699ee5e`。独立读取正式文件 1089 字节且 SHA 相同；无控制库写入、无新效果、无检查重跑。后续业务推进须由真实 Owner 读取并应用结果证明，不能由本文件修复直接宣称任务完成。

随后真实 Owner lease29/seq18546 提交收到，独立账回读 accepted/application_status=applied/application_failures=0，Owner idle/last_failure=null。实际选择检查 v2 digest `88ea5d22c73fce38983974ac2dd47293017114836ec42984b2a80d9f9f887ca0`；原 Run generation6 不变，revision12→13，verify-candidate running/lease2，未重新生成任务。脱敏独立快照 `docs/tmp/sg20-owner-check-revision-applied.json`；这是会话选择并实际应用检查修订的现场证明，构建/业务验收结果仍待真实执行，不宣称业务完成。
