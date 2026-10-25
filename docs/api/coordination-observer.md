# Coordination Observer API

The loopback observer exposes persisted coordinator inputs through read-only GET routes. The existing Host/Origin checks still apply; no route writes the coordination ledger.

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
