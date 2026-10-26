# Coordination Entity Ledger

2026-10-25. Pre-implementation analysis for the next UI iteration. Continues OPEN PR259 and the existing coordinator-work-visualization acceptance root; no merge authorization.

## Ground Truth And Goal

Read-only resident API confirms source fcc522d86cd7d242fc9c7240ab672a19bc0ecbf19eb6964831e642e1ea254a16 is an accepted change, attached to one once schedule revision2, state active, nextDueAt null. Its occurrence has message-reminder action succeeded and delivery failed; its job is completed. The primary result must be 提醒发送失败. Neither input acceptance, plan active nor job completion proves notification delivery or task completion.

The work list must identify durable arrangements, not messages that created or modified them. Preserve first-group defaults, compact rows, selection/focus separation and progressive disclosure. Changes are read-only projection/UI changes: no migration, state repair, notification retry, DingTalk send or input replay.

## Grain: Candidates And Decision

1. Source-message grain (existing): rejected. Create/change/query sources duplicate one durable schedule; source accepted only proves command acceptance.
2. One coordination batch per row: rejected as the sole grain. One batch can contain multiple independently timed schedules and direct work; one badge would collapse independent failures and plans.
3. Schedule/dispatch grain (recommended): one stable schedule ID across revisions, and one direct task-dispatch batch for members not governed by a schedule. Schedule templates and occurrence-instantiated members belong to that schedule and are not repeated as direct work. A schedule-less occurrence is its own dispatch/trigger row. Rows carry stable opaque identity, group, title, concrete primary result, updated/planned timestamps and only concise metadata. Source commands are history, never extra work rows. Unattached/rejected/query-only inputs remain available in the existing source API, not manufactured as arrangements.

Use the existing coordination.list/get, schedule/occurrence/job lists and task.get/notification readers. Reuse coordinationSnapshot for version-bound member proof; do not modify runtime aggregate/business state simply to make UI labels fit. Compute current entity results from complete collections before bounding presentation; provide truncation metadata.

## Result Priority And Independent Layers

The backend owns the projection so UI and tests share one decision path. List renders exactly one primary result, never a source accepted badge plus aggregate active badge.

- Select current effective occurrence by persisted planned/accepted/replacement facts, ignoring superseded entries as the current result but retaining them in history. Historical prior occurrences remain visible under disclosure. Different schedule revisions do not by themselves erase a real prior failed/sent outcome.
- Concrete uncertainty/failure is never erased by plan controls: notification unknown/failed, action unknown/failed/blocked/expired are explicit states, not generic 需要处理. Message-reminder delivery failure is 提醒发送失败; task-command delivery failure is notification failure, not task execution failure. Include recorded safe reasons where available, not raw diagnostics.
- Running requires actual action/job/task execution evidence, not active plan/task. Pending delivery is 待送达, not 已完成. Dispatch action succeeded means 任务已调度, not business finished. Message reminder delivered means 提醒已送达, not task complete.
- Formal task completion requires current fulfilled member state plus persisted version-bound completion proof. Historical proofs or task status alone do not complete a changed instruction. Mixed member states expose counts/individual facts rather than claiming all done.
- Plan control is a separate secondary layer: 周期计划已启用 / 已暂停 / 已取消, or single-shot plan state. Preserve already delivered/unknown/failed facts after cancellation; cancellation only describes future scheduling. A recurring plan may remain enabled while 本次提醒发送失败.
- Next step is independently grounded: valid nextDueAt permits 下次触发; persisted notification/job retry timestamp permits 已安排重试. If absent, explicitly 无后续触发安排 / 无重试安排. Do not infer a retry from failure, active state, elapsed time or existence of a job. Paused/cancelled plans do not advertise a stale scheduled nextDue as an active future promise.
- With no actual occurrence, show scheduled only when actual nextDue exists; otherwise 无触发记录 / 未安排下次触发. Unknown raw states map to 状态未确认, not success or running.

## Implementation Boundaries

- Extend packages/dingtalk-dsh-assistant/coordination-observer.js for entity list/detail and one primary result/plan/next-step DTO; retain existing source endpoints for history/diagnostics.
- Wire read-only methods in task-session-service.js, resident.js and http.js. Validate duplicate/unknown query parameters, paging and IDs; preserve Host/Origin and sanitized error behavior.
- Update only CoordinationBrowser and scoped styles in packages/dingtalk-dsh-observer/web-client.js. Retain abortable 5-second scope reads, stable group selection, pagination, focus and task return. Raw inputs/change records/evidence stay collapsed; status labels must remain visible in masked acceptance screenshots.
- Reuse existing test files and acceptance scripts. Only add a module if deterministic result logic cannot be expressed clearly in the existing observer; no new schema or generic framework.
- Sync README, API, design contract and current ops readback requirements.

## Team And Validation

Lead native CLAUDE_EFFORT=high is observed. New native Agent calls explicitly request effort low and ListAgents lists Teammates. Old-session member instances are absent from the current roster; keep the same lead/worktree/task identity but do not claim their processes were restored. Record actual native settings/provenance in shared-tasks; dynamic workflow is optional and not necessary for the two bounded analysis scopes.

Tests must cover single/recurring failure/success/unknown, pause/cancel retaining past effects, scheduled dispatch versus formal completion, mixed states, changed schedule deduplication, template/occurrence ownership and genuine nextDue/retry. Verify HTTP SQLite conservation and privacy. Use new rounds17+; old rounds are historical only. Isolated real React/primitives/HTTP/SQLite covers controllable scenarios, while installed3080 read-only browser must verify the original failed entity and existing dispatch, filters, manual/5s refresh, task return and390px screenshots. Preserve failed attempts in matrix.

Deploy only frozen verified packages after current ops Check; drain original lifecycle, install exact hashes/versions, independently read new/old PID, profile, dual ports, health, autostart and inbound/bridge recovery. No arbitrary restart on failure. Push only after re-reading PR259 state; keep OPEN and do not trigger CI or merge.
