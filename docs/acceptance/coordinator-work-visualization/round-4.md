# Round 4

2026-10-25. User-authorized local deployment and actual installed 3080 host verification. Prior isolated rounds remain unchanged. This round is IN PROGRESS, not acceptance PASS.

## Merge and immutable inputs

- PR258 independently read MERGED, mergedAt `2026-10-25T03:35:04Z`, merge `22d57386ebb5a11b89ab30e461a0b95e7bfc7f53`.
- Evidence branch `worktree-coordinator-work-deployment` starts at that merge; main checkout untouched.
- Persistent packages: `D:/dsh_home/packages/coordinator-work-22d5738`. Assistant2.1.0,390345 bytes,SHA256 `77eea78e705ee62085afc31baab956ce2f61d2f0dc8ad09dba98c2280c0fa2a9`; Observer2.1.0,58790 bytes,SHA256 `b5a468c15c4c11c757a3275887a72e8c65a2bdf438f2266f2d64514ec9f135cd`.
- Frozen patch SHA256 `74fe100c0019f5e4c76c06903fdb622b0af5696afc60ab38cbd252ce8f948499`, exact old PID84680. No schema/config/Host upgrade.

## Original Check recovery

- Operation `bpfbv3i6o` began approximately11:38+08:00; observed ledger/package child91760 creation11:38:41+08:00. Do not infer exact finish time from delayed notification.
- Independently read original terminal output: exit0,checkOnly=true,writes0,signals0,62 sessions verified,quiescent candidate,drained=true,unknownOperations0,unknownNotifications0. Not atomic shutdown proof.
- At12:09:52+08:00 old PID84680 still owns3080/18998, original package dependencies/profile unchanged, task enabled, evidence/lock absent. No installation had happened; no unknown write replayed. Health ok,recovery0,inbound true.
- Workflow maintenanceGET404 is expected in current task-session runtime. Its runbook selects `task-session-runtime-repair/scripts/deploy-task-session-native.ps1`, not historical workflow Bootstrap.

## Execution

- One execution `ba4b7mvd9` began about12:10+08:00 with original pins,no proposals,no backup. Runtime receipts: this worktree `docs/tmp/coordinator-work-native-20261025`.
- Latest valid activity: Check terminal plus independent live-state readback, then execution launch. Next observation: actual terminal notification and formal phase receipts. Busy alone is not progress.

## Observed Failure And Follow-up

- Original execution ba4b7mvd9 ended exit1 at start: `DEPLOY_NEW_PROCESS_NOT_READY`. The hard five-minute port wait expired. This failure remains in `round-4/failure.json`; it is not relabelled script success.
- Native SIGINT at12:11:48; old84680 exited, ports closed and descendants0; offline ledger at12:12:46 proves62 sessions drained,unknownOperations0/unknownNotifications0,ownerProcessExited=true. Stale owner metadata was not manually cleared.
- Assistant69 white-listed files and Observer4 matched exact package/source/installed hashes at12:13:33. Formal receipts copied to round-4: control/signal/quiescent/installed/observer-installed/failure JSON. Profile remained unchanged, no backup/Host upgrade.
- Scheduled task started same new91732(parent93000) at12:13:36. At12:17:35 only3080 was listening; at12:19:03 BOTH ports were listening. The same process loaded late; no reinstall/restart was attempted. Health/readback at12:19 and later is ok,recovery0,inbound true,bridge true,two listeners ready/backfills ok; authenticatedWeb200/exchange303.
- Root of the reported startup failure is the five-minute observation budget, not a package failure: same new process transitioned to ready after it elapsed with unchanged package/profile. The exact time inside that observation window is not asserted. A source-only script fix increases bounded wait to600s; regression `test/restart-web.test.js` 11/11 PASS including oldPID rejection,dual-port guard and timeout failure. It was not necessary or permitted to replay this deployment to test the timeout budget.
- The first actual-host browser run failed after successful entry/polling because an unrelated Codex Connect update notice intercepted the manual refresh click. Original result/screenshot remain round-4; real button enabled and pointer interception independently reproduced. Round-5 dismisses notice through normal UI, not force-click or hiding overlays.
- An ad-hoc Monitor was mistakenly given PowerShell instead of its Bash syntax and exited127; it is not deployment proof. Formal process/receipt/health readbacks above are the evidence.

## Browser baseline and boundaries

- Actual native-authenticated DeepSeek Harness at3080 opened its running dashboard before deployment: coordination navigation entry count0. Native verifier returned authenticatedHTTP200/exchange303,credentialPrinted=false.
- Use domcontentloaded/UI readiness, not networkidle: real host maintains persistent activity. No fabricated pre-change screenshot.
- Installed-host acceptance is PENDING. No fake responses, real message,notification retry/replay or business write. Only sanitized metadata in tracked evidence; local screenshots gitignored.
