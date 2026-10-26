# Coordination Dispatch Relations

2026-10-25. Pre-implementation snapshot for the explicitly authorized next version. Continue PR259 (OPEN, unmerged, head ca7a3fdd), existing worktree and unique acceptance root coordinator-work-visualization. No merge authorization or change to dispatch execution rules.

## Business Boundary

The ledger explains a coordination arrangement: formally complete prerequisite A, then dispatch target B. It does not report B running or formally completed as the coordination outcome. B's task page remains the authority for B execution. Show concrete task names, clickable task links, trigger condition, dispatch result and actual next step. Proof is evidence, never the primary next-action sentence.

When B is gated, B's task page explicitly says it is waiting for prerequisite A to complete and links to A. Multiple prerequisites list the actual unsatisfied items and the conjunction/disjunction supported by the persisted contract; never invent any-of support. Failure/cancellation/control/version changes follow actual stored dispatch guards, not a new universal rule.

Required transitions: prerequisite not satisfied -> waiting for A; prerequisites satisfied with an actual outstanding command -> pending dispatch B; recorded successful command/receipt -> B dispatch succeeded; recorded rejection/failure -> B dispatch failed with real reason. B active/fulfilled/completed cannot prove dispatch. Completion proof of A only determines whether the formal prerequisite is satisfied; it cannot prove B was dispatched.

## Candidate Representations

1. Keep batch task execution badges: rejected. It combines source acceptance, B execution and coordination, hiding the actual A-to-B gate.
2. Flatten every dependency edge into unrelated work rows: rejected. Multi-prerequisite conjunction and one target command become duplicated outcomes; scheduled/trigger identity would be lost.
3. Preserve durable schedule/trigger/direct-batch work identity, add one relation per target member with prerequisites and receipt-owned dispatch status: selected. List shows a concise named relation and one aggregate dispatch outcome; detail shows each target's prerequisites, condition, result, real next step and task link. Cross-trigger dependencies resolve from the complete coordination, before pagination/truncation.

## Current Evidence And Related Defects

Read-only18998 baseline: ten works, seven reminder schedules and three task-command triggers. Each trigger has one member; two have one dependency pointing outside their individual entity, so production relation verification is possible without injecting tasks or replaying commands. All three currently have fulfilled members; they must still display dispatch success only if actual command/receipt evidence supports it.

Three previous review findings are directly in scope: list-to-detail rejects legal durable slash/space/long IDs (breaks relation navigation); once-plan browser-local time is incorrectly suffixed with plan timezone (misstates trigger condition); cancellation before notification.start can fall through to query-success (misstates coordination result). Repair these narrow read projections/UI formatting, not persistence rules. The two already-fixed after-start cancellation/proof regressions remain mandatory regression coverage, not proof of the unfixed pre-start path.

## Implementation Ownership And Constraints

- Existing backend teammate: read-model/receipt/dependency/trigger/member contract investigation, relation DTO and backend tests, legal opaque ID round trip and cancellation-before-start repair. Existing task-read DTO may be extended only as necessary for task-page prerequisite display; no state machine or schema mutation.
- Existing UI teammate: current task detail dependency links and gate explanation, relation-first work rows/detail, remove internal proof next-action sentence, exact DTO consumption and narrow once timezone repair, relevant UI tests.
- Lead: integration/spec/docs, unique goal/shared/matrix, actual isolated HTTP/SQLite/React browser cases, frozen package integrity, runbook Check/native lifecycle deployment and authenticated3080 screenshots/PR readback. Existing independent reviewer remains read-only until final diff is ready. No new workflow or unbounded agent fanout.
- Requested effort: teammates low, lead high. Original native roster is present. Lead currently reads CLAUDE_EFFORT=null; actual inference effort is not proven by env or spawn settings. Preserve observed values and do not claim an unavailable runtime control was set.

## Verification And Delivery

New rounds start33; prior rounds remain historical. Add official-command isolated cases for waiting A, A formally completed with B genuinely pending, B command success without B completion, B rejection, chain/multiple actual prerequisites, current-version change, control cancellation/paused/failed prerequisite, duplicate trigger/command idempotence. Compare ledger result across B execution states without allowing those states to establish dispatch success. Query GETs must not change persistent SQLite.

Use existing real backend/browser harness, not a static mock. B task detail links back to A and return/navigation/focus work; screenshots retain relation words, condition, result and waiting reason. Mobile390 and desktop, explicit filters/manual/five-second refresh, no API/console/write errors. After isolated acceptance and relevant risk/release smoke, freeze dual packages and verify exact source bytes. Read ops/task-session-clean-start.md, Check first, native drain/disposal/install, independently verify package SHA/version/profile/old/new PID/dual ports/health/inbound/autostart. Actual3080 uses existing relationships and preserves all business data. No DingTalk test send, historical notification replay, production fixture injection, manual business writes, unrelated Host upgrade, user worker/window kill, CI dispatch, force push or merge259.

PR body must describe the new business boundary and actual tests/screenshots, including any unverified boundary. Re-read PR state before push and independently match local/remote/PR head and complete body afterward. Only conclude delivery after the unique matrix is green for this version.
