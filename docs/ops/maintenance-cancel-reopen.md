# Explicit reopen after maintenance cancellation

The existing authenticated Web reopen route also accepts a cancelled, unarchived task after execution drain. It preserves the original task/session identity and increments the requirement, control and run revisions. It does not restart an old execution or replay commands.

A terminal, drained execution does not need `cancelRequested=true` to enter recovery. Reopen preserves superseded operator requests; the Owner creates a new request bound to the current revisions for the existing `/tasks/:taskId/human-requests/:requestId/reply/check` and `/reply` flow. Do not reuse a superseded request or change a successful execution into a cancelled one.

When a process-drain failure lost its in-memory scope across restart, the same reopen route accepts the existing installer audit:

```json
{
  "requestId": "resume-original-after-maintenance",
  "context": "Resume the original task; inspect unknown effects without replay",
  "expectedRequirementRevision": 4,
  "expectedControlRevision": 5,
  "maintenanceEvidence": {
    "directory": "D:/approved-maintenance-audit",
    "expectedProposalDigest": "<SHA256 returned by the frozen maintenance inspection>"
  }
}
```

Read current task revisions before submitting. The directory contains the original `drain-maintenance-proposal.json`, `drain-maintenance-preflight.json`, `control.json`, `captured-descendants.json`, `signal.json`, `quiescent.json` and `drain-maintenance-cutover.json`. The Host checks the exact frozen execution/input/lease, complete native log digest, matching preflight/offline/cutover proofs, original Host identity, captured descendant ancestry and a fresh read-only observation of those process identities. A changed whole execution row after restart is not itself a binding mismatch. Missing evidence, changed input/history, an original process still alive or a changed lease rejects recovery. It records physical drain with its evidence and original failure; it does not invent a Job receipt, successful business result or operation settlement. Windows process observation must succeed; absence of a PID alone is insufficient.

If a Topic context batch failed solely with `DYNAMIC_TASK_NOT_ACTIVE` before any action or reply was applied, successful reopen retains that rejected decision and releases its reservations atomically. All its original messages remain unprocessed until a new Topic decision reads the current task version and applies the supplements. A dynamic operation receipt, partial progress or related outbox prevents this automatic reconsideration. Concurrent retries cannot reactivate the old batch while reopen is pending. This uses normal Topic processing, without a new task or replay of the stale action. The inbox distinguishes inactive-task context from unknown-effect replay restrictions.

With no unresolved effects, new authorized work may continue normally. With completed native job receipts or the exact Host identity error, all original executions must be terminal and drained, and each observation must match its original task, execution and session. The existing `restartRecoveryOperations` gate then permits only bound read-only investigation and reconciliation until those observations are audited. Other unknown errors, active writers and mismatched bindings remain rejected. The original Host-restart isolation exception remains available with its existing conditions.

Reopen never changes an operation result. Native failures still require the existing evidence and operator confirmation. Existing job reconciliation keeps a cancelled receipt cancelled with possible partial effects, even if its process status says completed. Historical isolated jobs retain unknown results and their original audit.

Validation covers stale control revisions, duplicate requests, restart persistence, foreign origin/task/session, incomplete evidence, active execution, preserved historical unknown jobs, and the real HTTP/Topic/ledger path. No database state is edited directly in deployment.
