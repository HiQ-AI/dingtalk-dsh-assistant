# Coordinator Work Visualization Report

## Delivery

PR #258 is MERGED: https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/258

- Merge: `22d57386ebb5a11b89ab30e461a0b95e7bfc7f53`, mergedAt `2026-10-25T03:35:04Z` (independent gh readback).
- Subsequently authorized local deployment and real installed 3080 host read-only acceptance completed; see round-4/5/6 for preserved failures and final proof.
- Original deployment script exited1 at the five-minute startup wait. Same new PID91732 became ready without reinstall/restart; original failure retained, independent final package/process/health readback PASS. A new source-only follow-up fixes the bounded wait to600s, with11 regression PASS.
- Actual real-host default-light desktop/mobile each pass11 cases;18 existing sources,2 dependency members,3 proof members. Console/API/mutation requests0. Actual installed dark remains unverified because persisted Host light overrides browser preference; no Host settings changed.

- Base: `main`
- Head: `worktree-coordinator-work-visualization`
- Implementation commit: `6c495d09a3c30381f29558a0068bb1ef88d2d910`
- Remote state read independently with `gh pr view`: `MERGED`; merge SHA/time match the intended delivery.
- Local dual-package deployment performed under subsequent user authorization. No operator business write, real DingTalk test send, notification replay, CI dispatch, main push or force-push.

## What changed

The existing observer now has a read-only **协调工作** page backed by the real resident service and dynamic SQLite store:

- A bounded source list and source detail API at `/state/coordination-sources`, with group filtering, server pagination, explicit 400/404/503 behavior and safe diagnostic fields.
- A field-by-field projection that preserves reserved, rejected, clarification and unattached inputs; reuses `coordinationSnapshot`; keeps accepted/applied, formally fulfilled, action success and notification delivery distinct; and reports detail collection truncation.
- An observer page using existing host primitives and navigation, with task/dependency reading, saved decisions and limitations, waiting/blocking reasons, schedules, occurrences, delivery state and version-bound proof references.
- Independent 5-second list/detail reads with abort and scope identity guards, stale-data retention on same-scope failure, explicit retry, keyboard focus restoration and plain-text business content.
- A narrow-screen header fix based on a real 390px overflow finding: the grid can shrink, the status cluster wraps, and the refresh control is not clipped. Existing navigation remains locally scrollable.
- API/design/runbook documentation, package whitelist closure, focused regression coverage and an isolated Chrome/React/primitives/HTTP/SQLite acceptance harness.

Key implementation locations:

- `packages/dingtalk-dsh-assistant/coordination-observer.js:18`
- `packages/dingtalk-dsh-assistant/http.js:264`
- `packages/dingtalk-dsh-assistant/task-session-service.js:85`
- `packages/dingtalk-dsh-observer/web-client.js:532`
- `packages/dingtalk-dsh-observer/web-client.js:1792`

## Verification

The acceptance matrix in `docs/acceptance/coordinator-work-visualization/matrix.csv` is green for round-3.

- Relevant regression command: 167 PASS, 0 FAIL, 0 cancelled, 0 skipped.
- `node --check packages/dingtalk-dsh-observer/web-client.js`: PASS.
- `node scripts/test-suites.mjs check`: 308 files verified, each exactly once; historical 3; deleted 0.
- Assistant `npm pack --dry-run --json`: 70 files and `coordination-observer.js` present; no package published.
- Observer `npm pack --dry-run --json`: 4 files and final `web-client.js` present; no package published.
- Strict frontend audit: findings/errors/warnings/violations/unresolved all zero.
- Round-3 seeded Chrome: desktop light 13 cases; desktop dark, mobile light and mobile dark 12 cases each; all PASS.
- Round-3 independent empty SQLite: desktop light and mobile dark 2 cases each; both PASS.
- The browser harness loaded actual React 18.3.1 and more than 100 native primitive exports. It used real production HTTP, SQLite and task-service read DTOs. It verified real task detail drill-through and return to the selected coordination source, a production command changing SQLite followed by observed 5-second polling, delayed-response isolation, network failure/recovery, formal proof and dependency waiting, keyboard focus and 390px no horizontal overflow.
- Lead independently verified 36 source hash/byte pairs and 10 PNG hash/byte pairs (1,009,890 bytes). Final screenshots were directly inspected in light/dark desktop and mobile variants and an independent empty state.
- The earlier 390px observer overflow (`scrollWidth=394`, `clientWidth=390`) remains documented as round-2 FAIL; round-3 passes after the header fix. Evidence was not overwritten.
- The acceptance scripts reject output outside the formal acceptance root and reject non-`round-N` directories with exit code 2. Host `--check` passed without creating runtime data or listeners. Formal evidence is under the worktree `docs/acceptance/coordinator-work-visualization/`; jobs/tmp contains only runtime staging/dependencies.

## Boundaries

The round-3 browser harness is a deliberately minimal ModuleLoader/slots/session adapter, not complete installed-host proof. Subsequent round-6 separately verified the actual installed host:

- Assistant2.1.0 SHA256 `77eea78e705ee62085afc31baab956ce2f61d2f0dc8ad09dba98c2280c0fa2a9`, Observer2.1.0 SHA256 `b5a468c15c4c11c757a3275887a72e8c65a2bdf438f2266f2d64514ec9f135cd`.
- New91732/parent93000 owns3080/18998; old84680 absent; profileSHA74fe100c unchanged, Host0.2.1-rc.2 unchanged, autostart enabled/running.
- health=ok,recovery0,inbound true,bridge healthy,listeners ready/backfills ok; authenticatedWeb200. Retired maintenanceGET404 is expected; native disposal/autostart restoration, not a legacy Resume.
- Not performed: real model inference, real DingTalk test send, operator notification reconciliation/replay, business mutation, actual installed dark-theme switch, production fault/empty-state injection or CI dispatch.

Business input, requirements, summaries and evidence may contain sensitive local content. The projection is a local privileged observer view, not a public redacted export. It excludes actor/recipient IDs, prompts, commands, raw proposals, paths and raw diagnostics. GET operations are read-only and do not retry commands, notifications or business processing.

Round-3 isolated and round-4/5/6 actual-host results retain separate provenance. PNGs are local/gitignored; JSON/hash metadata/scripts/round summaries tracked. Final actual screenshots: `round-6/native-desktop-light-detail.png` and `round-6/native-mobile-light-detail.png`, masked business text and no Host sidebar. PR258 merged and local dual-package deployment verified; startup-wait source fix and evidence use a NEW follow-up branch/PR, never push the merged implementation branch.

## Follow-up Delivery

Startup readiness wait300->600s and final deployment evidence are delivered in PR #259 (OPEN): https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/259. Independent gh readback matched main/base,worktree-coordinator-work-deployment/head,implementation commit5ccfd218ed84711af21850526ed5586a4110b364 and complete checked local PR body. Local regression rerun11/11 PASS; no follow-up merge/redeploy or CI dispatch. PR258 remains MERGED and its implementation branch was not pushed. Final bookkeeping is a docs-only closure on PR259.


## Refinement Closure (2026-10-25)

The follow-up UI feedback is implemented on the unmerged PR259 branch. The first valid group is selected in stable returned order without an initial all-groups read; empty/invalid scopes, explicit all, refresh/poll retention and task return are covered. Source rows are compact 67px two-line entries at desktop and the detail pane prioritizes actual schedules or task dispatch before collapsed raw/history/evidence sections. Completion and delivery remain separate, and missing next actions are not invented.

Candidate deployment was authorized after Check and completed once. `candidate-readback.json` independently verifies final Assistant/Observer 2.1.0 package hashes, profile SHA, new PID45548, old PID91732 exit, dual ports, autostart, health, inbound/bridge readiness and authenticated Web; no business writes, notification replay, DingTalk send or Host setting change occurred.

Round16 is the final actual-host browser ground truth: five desktop/mobile/light/dark/forced-colors variants, 7 cases each, no console/API/mutation errors and no horizontal overflow. Round12/13/15 failures remain preserved with round14 diagnostic context; they are not rewritten as passes. PR259 remains OPEN and no merge or CI dispatch was performed.

Final regression rerun101/101 PASS with exact command in round-16.md; earlier round11 risk scope136/136 is separately preserved. Source/hash check5/5 and screenshot hash/byte pairs20/20 MATCH. Same native size comparison: desktop5->10 and mobile4->8 visible rows; row height111-153px->67px. Actual installed dark remains UNVERIFIED (persisted light); source-isolated dark was verified separately. Native low reviewer re-read all three fixes and independently ran the cross-group/history test1/1PASS.

- Final refinement delivery: PR259 https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/259 independently read OPEN/unmerged,main <- worktree-coordinator-work-deployment. Implementation7cdf44d6141204aa3a0029598d6361062e322124 matches local/remote/PR head; complete body matched checked deployment-pr-body.md. Snapshot in round16/pr-readback.json precedes this docs-only closure; no merge or CI dispatch.

## Entity Ledger Closure (2026-10-25)

PR259 remains **OPEN / unmerged**: https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/259. Implementation `9844c48095af01272711243af1edd3f960b8fdb0` independently matched local/remote/PR head and the complete checked PR body (round32). This final documentation-only closure follows that snapshot. Every entity-ledger case has latest applicable PASS in the unique matrix; earlier failures remain preserved.

### Delivered Behavior

- Schedules retain one stable identity across revisions. Independent unscheduled triggers retain occurrence identity; remaining direct task members aggregate by coordination batch. Source inputs and changes become collapsed history, not duplicate work rows.
- One backend-owned primary result separates actual delivery/action outcomes from plan controls and command acceptance. Formal task completion requires current version-bound proof, not active state or a completed job.
- A denied permit before any send is cancellation, not a send failure. Cancelling an unsent result notice cannot erase current formal task completion. Both boundaries were reproduced as failing regressions before repair (round24/28).
- Only recorded nextDue, send retry and readback times imply future actions. Missing records are explicit. Compact first-group UI retains scope isolation, pagination, separate selection/focus, manual and five-second refresh, and task-detail return; evidence/history default collapsed.

### Final Verification

- Directed tests: 76 PASS. Expanded relevant risk tests: 149 PASS, 0 FAIL, 0 SKIP. Release smoke: 12 PASS, 0 FAIL, 2 SKIP because the full native dsh-base profile was unavailable; not 14 PASS. Suite map: 308 files, each exactly once, historical3. Syntax, Python AST and diff checks pass; exact commands are in round29.
- Final-source isolated React18/primitives/production HTTP/SQLite: four variants, eight cases each PASS, covering ten persisted reminder states including cancellation before send. Actual isolated dark, 390px, forced colors, first/empty/all scopes, focus, refresh and task return are covered. Twelve source and twelve screenshot identity checks match. The minimal slots adapter is not a full native Host.
- Final native deployment round30 used runbook Check first: writes0/signals0,62 verified sessions drained, unknown operations/notifications0. Final candidate executed once. No operator business-ledger edit, schema migration, notification replay or real DingTalk test send.
- Package root: `D:/dsh_home/packages/coordinator-entity-ledger-proof-20261025`. Assistant2.1.0: SHA256 `5bf60b8cb3446292b68d2323e56fa0c962b2c56ad3420ee327c3f12dc9862dee`,393380 bytes. Observer2.1.0: SHA256 `6f58d449e9af04e372e52dff5a3dff3b26656b292791ccd80bda1722f50d0c3a`,59580 bytes. Seventy plus four source files independently byte-match the frozen packages.
- New PID91256 owns3080/18998; old18784 exited. ProfileSHA74fe100c and Host0.2.1-rc.2 unchanged. Independent readback: autostart enabled/running,health ok,recovery0,inbound true,bridge/listeners ready,backfills ok,authenticated Web200.
- Final installed round31: desktop1440/mobile390/dark preference/forced-colors each six cases PASS. Ten unique entities comprise seven schedules and three task triggers. Original failed reminder is primary `提醒发送失败`, with no invented next trigger/retry. TaskHTTP200/return, selection/focus/filter/manual+five-second refresh and no overflow are verified; console/page/API errors and resident mutations0. Twelve source plus twelve screenshot byte/hash identities match. Final desktop/mobile failed-reminder screenshots were personally inspected.

### Screenshots And Limits

Local, gitignored screenshots retain readable results, plan and next steps while masking business text:

- `round-31/after-desktop-light-failed-reminder.png`
- `round-31/after-mobile-light-failed-reminder.png`
- `round-31/after-desktop-light-dispatch.png`

Native Host retained light under dark preference; actual installed dark remains UNVERIFIED. Actual isolated dark passed separately. No real model/channel end-to-end send, production fault injection or notification replay was authorized or performed. Large screenshots/raw health are local and ignored; committed drivers and metadata support fresh-round regeneration. Isolated19087/19088 were stopped and independently had no listeners; native91256 was unaffected.

Original named teammates returned no final report. An explicitly new native low-spawn reviewer found the completion/cancellation defect with prior75 directed PASS and query reproduction. Lead independently added a failing regression, repaired it, and verified76/149 PASS; the reviewer did not independently rerun the final diff/browser matrix. Extra skill-spawned execution was stopped and not used. Native roster and requested low spawn setting are evidenced; actual inference effort is not independently proven by an empty environment value. No resumed old process or invented workflow is claimed.

No PR259 merge, manual CI dispatch, main push or force-push. Round32 closes the delivery evidence without rewriting earlier candidates or failures.
