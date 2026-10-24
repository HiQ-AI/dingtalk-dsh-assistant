# 第八轮：权限与摘要修复后真实ABC续办

## 目标与门禁
修复A终端权限阻断与群摘要接纳/完成混淆，受控部署后沿原A/B/C继续；不关闭沙箱、不广放ACL、不改完成账本、不人工启动B/C。

## 开工基线
- 22:03:51 当前包9f41510、PID73984；health degraded唯一A blocked，入站正常。
- PR257 OPEN；PR256已合main5ab3c46，9f41510..main仅验收docs差异；保留现包功能。
- A request仍waiting-reply，requirement/control均1；无operation/execution，产物目录不存在。
- 两名真实sequence-worker由SendMessage恢复分工；ListAgents独立读回两者running，lead未改变high。

## 当前状态
NOT_RUN。实际修复/测试/部署/业务结果分层追加，不以角色列表或命令退出0替代证据。

## 实跑回归与恢复前证据
- lead实际执行 node --test test/coordination-summary.test.js test/coordination-trigger-commands.test.js test/coordination-observed-prerequisites.test.js：56 PASS/0 FAIL/0 SKIP，日志docs/tmp/coordinator-abc-validation/round-8/lead-targeted-tests.log。
- 原生inspect-quiescent-ledger.mjs：quiescent=true/candidateOnly=true/drained=true/verifiedSessions=60/unknownOperations=0/unknownNotifications=0；这只是停机前候选，正式部署仍需原生退出和进程证明。
- 新read-sequential-evidence.mjs使用readOnly+query_only+同一事务，SQL按本coordination/三Task选择收据，避免加载全库。实跑12条相关收据/3Tasks/3members/0events/0executions/0operations；本地原始快照before-repair-ledger-filtered.json（约130KB）。

## 能力与环境实况
- dynamic workflow实际调用失败：sequence-worker在workflow注册表不可用，未产生队员结果；保留真实原生两队友，不更改其low或lead high、不强造workflow成功。
- 发行烟测首轮失败日志保留：隔离worktree缺acorn/dsh-client-ui-primitives，并出现原生package30s timeout；正按项目契约pnpm install --frozen-lockfile补工作树依赖，未改宿主profile依赖。

## ACL修复脚本与环境修复进展
- contract-worker已提供精确脚本repair-task-sandbox-acl.ps1：仅允许3个原Task根，当前owner非管理员，Check只读探针WRITE_DAC/WRITE_OWNER/combined与SDDL；Execute前保存SDDL证据，DACL-only增加当前owner WRITE_OWNER ACE，保留owner/group/SACL/mandatory label/deny，写后回读有效权限并在失败时停止。lead先实跑Check，未执行ACL写入。
- 官方ACL说明已确认grantWrite同时写DACL和Low label，Win32 5根因是WRITE_OWNER缺失；不是需要管理员或全盘放权。
- pnpm install --frozen-lockfile在隔离工作树完成，补齐acorn、dsh-client-ui-primitives等；烟测重跑后台进行，首轮失败原始日志保留。

## ACL修复已执行
- Lead先实跑repair-task-sandbox-acl.ps1 -Check：3根均currentOwner=true/writeDac=true/writeOwner=false/combined=false。
- Lead以唯一脚本-Execute、证据目录round-8/acl-repair执行：verified=true，DACL-only为当前owner增加WRITE_OWNER ACE；仅三Task根，保留owner/group/SACL/mandatory label/deny。独立新进程再次-Check三根均writeOwner=true/combined=true。
- 尚未恢复A或重启Host；下一步先按受支持HTTP人工reply/check核未知效果，再验证原生工具可启动；不修改B/C hold。
## Summary修复包与测试
- 56 targeted PASS/0FAIL/0SKIP。build-web-client无bundle diff。固定Assistant包放D:/dsh_home/packages/coordinator-abc-20261024-summary/，SHA256 BD8391468DFC74469C0E71AD5C05E002C5FF98156483BAEF216B37277D4F06AC。
- 首轮release smoke已因隔离依赖缺失失败；pnpm install --frozen-lockfile补齐后重跑13PASS/0FAIL/1cancelled，唯一原生package case超时30s，未将其算通过；原始日志保留。冻结包单文件原生烟测后台重跑中。

## 受控部署已进入执行阶段
- 读取当前真实PID73984/现profile SHA74fe.../current Observer原包，原生task-session-runtime-repair deploy-task-session-native.ps1 -Check已通过：signals=0/writes=0/quiescent=true/drained=true/unknownOperations=0/unknownNotifications=0/verifiedSessions=60。
- 固定Assistant摘要包SHA BD839146...；Observer保持9f41510包。正式执行后台进行，结果按runbook独立回读新PID/health/profile/package/dispatch；失败不自动重装。
