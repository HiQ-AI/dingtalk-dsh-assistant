# Explicit reopen after maintenance cancellation

The existing authenticated Web reopen route also accepts a cancelled, unarchived task after execution drain. It preserves the original task/session identity and increments the requirement, control and run revisions. It does not restart an old execution or replay commands.

With no unresolved effects, new authorized work may continue normally. With completed native job receipts or the exact Host identity error, all original executions must be terminal and drained, and each observation must match its original task, execution and session. The existing `restartRecoveryOperations` gate then permits only bound read-only investigation and reconciliation until those observations are audited. Other unknown errors, active writers and mismatched bindings remain rejected. The original Host-restart isolation exception remains available with its existing conditions.

Reopen never changes an operation result. Native failures still require the existing evidence and operator confirmation. Existing job reconciliation keeps a cancelled receipt cancelled with possible partial effects, even if its process status says completed. Historical isolated jobs retain unknown results and their original audit.

Validation covers stale control revisions, duplicate requests, restart persistence, foreign origin/task/session, incomplete evidence, active execution, preserved historical unknown jobs, and the real HTTP/Topic/ledger path. No database state is edited directly in deployment.
