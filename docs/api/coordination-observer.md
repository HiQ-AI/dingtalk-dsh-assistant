# Coordination Observer API

The loopback observer exposes persisted coordination entities and source history through read-only GET routes. The work browser uses entities; source endpoints remain diagnostic/history readers. The existing Host/Origin checks still apply; no route writes the coordination ledger.

## `GET /state/coordination-work`

Accepts only `groupId` (optional nonempty string), `offset` (safe integer >=0, default0), `limit` (1..100, default20), each at most once. Invalid/duplicate/unknown parameters return400 `coordination_query_invalid`; unavailable readers/storage return503 `coordination_observer_unavailable`. Existing Host/Origin validation is unchanged.

Returns `{works,total,offset,limit,observedAt}`. The full group collection is assembled before result computation, sorting and pagination. No source-page deduplication occurs. Stable opaque IDs are `schedule:<scheduleId>` across revisions, `dispatch:<coordinationId>` for direct members not owned by schedules, and `trigger:<occurrenceId>` for schedule-less occurrences. Schedule templates, historical action instructions and occurrence-instantiated members belong to their schedule, not another direct work row. Unattached, rejected and query-only source messages do not manufacture entities. Order is updated time descending then opaque ID.

Each work is `{id,kind,coordinationId,groupId,title,updatedAt,result,plan,nextStep,counts,relations,relationCount,scheduleId,occurrenceId}`. `kind` is `schedule|dispatch|trigger`; nullable identities remain null. Task-command titles name the prerequisite-to-target relation; reminder titles use recorded reminder text. Neither is a source command presented as another arrangement.

- `result`: exactly one `{code,label,tone}` owned by the backend. Task-command work aggregates receipt-owned relation dispatch states, never target execution or completion. A success requires exact-command durable acceptance; missing receipts, unsatisfied prerequisites, unreleased triggers, controls and recorded rejection/failure remain distinct. Reminder work retains actual delivery/action results ahead of plan controls; delivery failed is `提醒发送失败`. Pending delivery is not completion. Unknown raw states remain unconfirmed.
- `plan`: `{state,label,recurrence,timezone,rule}`. Rule is nullable `{kind,at,time,weekday}`. Plan active is not execution evidence. Pause/cancel describes future control and cannot erase persisted failed/delivered/unknown effects. Recurring enabled and latest failed reminder may coexist.
- `nextStep`: `{triggerAt,sendRetryAt,readbackAt,label}`. Valid nextDue of an enabled plan permits next trigger. Persisted notification nextAttemptAt plus the actual safe retry contract permits send retry; unknown-send readback is separately labelled verification, not resend. Source planning retry is never borrowed. Missing timestamps explicitly report no subsequent trigger/retry arrangement; paused/cancelled cursors are not future promises.
- `counts`: `{total,fulfilled,blocked,waiting}`. For task-command work these count dispatch relations: `fulfilled` is receipted dispatch, not target task completion; blocked includes failed/stale/unknown, waiting includes waiting/pending/paused. They are diagnostic and not rendered as business-completion badges. Formal prerequisite satisfaction separately requires the current receipt/proof, matching task completion and instruction/version identity.

Current occurrence selection excludes superseded/replaced/merged instances and uses persisted planned/accepted times. A queued future slot or a later cancellation of an unstarted slot does not erase the latest actual effect. Notification ledger terminal/unknown truth remains authoritative when occurrence control was subsequently rewritten. A `coordination_cancelled` permit denial with no send permit/attempt/ACK/receipt is cancellation, not a failed send; it cannot erase an already current-proof-completed task. Earlier occurrences stay in history. Reads are not a cross-table transaction snapshot; `observedAt` is an observation window.

## `GET /state/coordination-work/:workId`

No query parameters. Requires a percent-encoded stable ID with the above prefix and a nonempty opaque suffix of at most 1,000,000 characters, matching the durable store contract. Spaces, slashes, backslashes and other legal durable characters round-trip without being treated as path separators. Malformed IDs return400, missing valid IDs404 `coordination_work_not_found`, read failures503 with a sanitized error.

Returns `{work,members,relations,history,collections,observedAt}`. `relations` describes each target instruction with `condition: "all"`, named prerequisites, `state`, and receipt-owned `dispatch` facts. The task detail DTO exposes the same relations under `coordination`. `history` is an object with arrays `sources`, `changes`, `occurrences`, `jobs`, each bounded to latest100; `members` is similarly bounded. `collections` has matching `{total,returned,truncated}` entries. Main result/counts are calculated from complete data before bounds. Sources are associated with the coordination batch; association does not prove each source changed this particular schedule.

Source fields reuse the safe source DTO below. Changes whitelist sourceId/revision/reason/action/at; schedule revision entries additionally include scheduleId/state/timezone/rule/nextDueAt, never raw action/target. Occurrence history whitelists occurrenceId/scheduleId/plannedAt/cancelledAt/paused/actionKind/actionState/deliveryState/failureCode/replacementOf/replacedBy/mergedInto. Jobs whitelist jobId/occurrenceId/state/attempt/failureCode. Freeform diagnostics become a neutral fault code; actor/recipient IDs, prompts, raw payloads, transport permits, commands and paths are excluded. Members reuse snapshot dependency/requirement/decision/reorder projections; `completionProofCurrent` marks validated proof, `completionProof` is current only, and stale proof is isolated in `historicalCompletionProof` with a downgraded version-changed state; evidence is recorded, not independently verified by the browser.

## Dispatch Relation Boundary

Task-command work reports prerequisite-to-target dispatch, not target execution. A prerequisite is formally satisfied only by the actual current-proof and control/version contract. Target active/running/fulfilled/completed cannot establish a dispatch receipt. The relation keeps target identity and name, actual prerequisite task links, the supported dependency mode, trigger condition, dispatch result/reason and real next step. Unsatisfied prerequisites remain visible on the target task detail; satisfied items are not described as waiting. Current implementation supports conjunction (all prerequisites), not invented any-of.

A matching persisted command receipt establishes dispatch success independently of later target task execution. Failure/rejection records establish failure; no receipt remains pending/unconfirmed as appropriate. Later prerequisite or plan control changes cannot rewrite a past confirmed dispatch as not dispatched. Conversely a current prerequisite proof without a B command/receipt cannot establish B dispatch success. Repeated triggers sharing an idempotent command do not imply a second delivery. Complete cross-trigger and cross-coordination prerequisite resolution happens before list pagination and detail truncation.

Task proof remains evidence under disclosure; the next-action sentence does not say that a current instruction has formal proof. The task page owns the target's execution/result. Reminder delivery results and actual notification retry/readback facts remain separate from task-dispatch results.

## `GET /state/coordination-sources`

Accepted query parameters are `groupId` (optional), `offset` (default `0`) and `limit` (default `20`, maximum `100`). Unknown, duplicate or invalid parameters return `400`; runtime/storage read failures return `503` with `coordination_observer_unavailable`. Sources are ordered newest first and include reserved, rejected, clarified and unattached inputs. Every nonempty persisted source processing failure is represented by `failureCode: "coordination_processing_failed"`, never its raw diagnostic text, even if identifier-like.

```json
{
  "sources": [{
    "id": "source-id", "groupId": "group-id", "original": "business input",
    "createdAt": "2026-10-25T00:00:00.000Z", "state": "accepted", "settled": true,
    "coordinationId": "coordination-id", "acceptedKind": "arrangement", "acceptedRevision": 1,
    "question": null, "answerText": null, "rejectionReason": null, "attemptCount": 0,
    "nextRetryAt": null, "failureCode": null
  }],
  "total": 1, "offset": 0, "limit": 20,
  "observedAt": "2026-10-25T00:00:00.000Z"
}
```

## `GET /state/coordination-sources/:sourceId`

A missing source returns `404`. A runtime without this reader returns `503`; invalid path/query input returns `400`.

The response contains `source`, nullable `coordination`, nullable `snapshot`, `members`, `observedAt`, and `collections`. `coordination.history` is bounded to the latest 100 records. Detail collections are bounded to 100 records and report `{total, returned, truncated}` in `collections`; aggregate state is computed before presentation truncation.

`coordination` contains only `id`, `revision`, `state`, `createdAt`, and history entries with `sourceId`, `revision`, `reason`, `action`, and `at`. `snapshot` contains `state`, `fulfilled`, `pendingClarifications`, and safe schedule/occurrence/job projections. Schedule and occurrence delivery state remains separate from action state; recipient IDs, actor IDs, prompts, commands, raw accepted proposals, paths and raw error text are not returned.

Each member contains `instructionId`, `taskId`, `title`, `state`, `taskState`, `control`, dependency instruction IDs, `requirement`, `waitingReason`, `blocker`, the recorded `reorderAssessment` (when present), the task's recorded `decision` (action, summary, evidence, limitations, at) and formal `completionProof` references. A command being accepted or applied is not a formal completion proof; `completionProof` is absent until the persisted version-bound proof exists.

`snapshot` fields are:

- `state`: the existing `coordinationSnapshot` aggregate; `fulfilled`: its formal fulfilled-member count.
- `pendingClarifications`: `{clarificationId, question}`.
- `schedules`: `{scheduleId, revision, state, nextDueAt, timezone, reminderText, rule}`. A nullable rule contains only `{kind, at, time, weekday}`.
- `occurrences`: `{occurrenceId, scheduleId, plannedAt, cancelledAt, paused, actionKind, instructionIds, actionState, deliveryState, resultRef, failureCode}`. `resultRef` is an opaque persisted result reference, not a downloadable path or URL.
- `jobs`: `{jobId, state, failureCode}`. Structured `failureReason.code` may retain its bounded identifier-like code; every freeform occurrence/job diagnostic string becomes `coordination_trigger_failed`. Raw diagnostic strings or objects are never returned.

`members` fields are `instructionId`, `taskId`, `title`, `state`, `taskState`, `control`, `dependencies` (instruction IDs), `requirement`, `observation`, `progressImpact`, `impactReason`, `waitingReason`, `blocker`, `reorderAssessment`, `decision` and `completionProof`.

`source.answerText` is the nullable recorded business answer from `acceptedProposal.answerText` only; no other proposal fields or reasoning are projected. `observation` is boolean; `progressImpact` (`preserve`/`replan`) and `impactReason` are nullable recorded scalars, not inferred decisions.

- `waitingReason` is nullable `{code, dependencyInstructionIds}`.
- `reorderAssessment` is nullable `{id, state, decision, summary, evidence}` copied from the recorded owner assessment, without owner bindings or raw command arguments.
- `decision` is nullable `{action, summary, evidence, limitations, at}` copied from the task's last recorded decision. Missing evidence is an empty array; no reasoning is synthesized.
- `completionProof` is nullable `{eventId, commandId, requirementRevision, contextRevision, controlRevision, runSequence}` copied from the version-bound proof. Accepted/applied commands are not formal completion.
- `collections` has keys `history`, `members`, `schedules`, `occurrences`, `jobs` and `pendingClarifications`, each with `{total, returned, truncated}`. The latest 100 records in each ledger-order collection are returned; source list pagination remains independent.

`observedAt` marks the read observation window, not a guaranteed transactionally consistent snapshot across tables. New source/coordination revisions can appear on the next refresh.

All business text is returned as plain JSON strings for the local privileged observer. The API does not provide mutation, retry, notification, command or chain-of-thought access.
