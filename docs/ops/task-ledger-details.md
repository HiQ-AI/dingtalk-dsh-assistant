# Task-owned ledger details

The control database keeps identity, state, leases, locks, unique command digests,
cross-task scheduling facts and bounded observer projections. It is no longer the
only copy of task requirements, execution inputs/results, dialogue or receipt
payloads. The existing native session JSONL remains the session/tool-I/O fact
source; this change does not copy or export those logs.

## Ownership and format

- Task details: `<workspace>/tasks/<taskId>/.dsh/ledger-details/objects.sqlite`.
- Cross-task coordination details: `<workspace>/coordinations/<coordinationId>/.dsh/ledger-details/objects.sqlite`.
- Details without a task or coordination owner: `<workspace>/.dsh/ledger-details/unassigned/objects.sqlite`.
- Task/execution workspaces, `materials`, native `.dsh/sessions` and `outputs`
  retain their existing meanings. The Host manages the ledger-detail containers;
  model-editable files or execution Markdown are not recovery authority.

Each central `_hostDetail` reference identifies its table, record, owner and a
SHA256-addressed object. The object binds the compact control projection to the
detail, preventing a stale or substituted detail from being paired with newer
control state. Content-addressed subtrees share unchanged history entries and
snapshot fields. One local container per owner avoids thousands of small files;
there is no full-snapshot export on every poll.

The first externalized write raises SQLite `user_version` to 3 so older binaries
reject the ledger instead of interpreting projections as complete records. New
code also reads legacy inline version-2 bodies; it rewrites only changed records.
An old binary cannot be rolled back onto a converted database: rollback selects
the preserved original database and its matching original workspace instead.

## Commit and recovery

1. Publish immutable detail objects in a local SQLite transaction with FULL
   synchronous durability.
2. Commit the control state, command digest/result reference, causal wake and
   notification intent in the existing single control transaction.
3. Dispatch external work only after that control transaction succeeds.

A failure before step 2 can leave unreferenced local objects, never a published
command result. Retry can reuse identical objects. A committed command replays
the verified original result; missing, corrupt, mismatched or unsafe detail fails
explicitly and never authorizes repeating an operation. Unknown-effect operations
and resource locks retain their existing reconciliation requirements. No automatic
object deletion or retention expiry is introduced.

Reads/writes validate the canonical workspace and descendant paths, reject unsafe
IDs, links/junctions and substituted container files, and verify hashes and record
identity. Handle caching is capped at 32 containers. Transaction-local decoded
cache is capped at 256 entries / 8 MiB and cleared after each transaction; detail
traversal is bounded by depth 128 and 100,000 nodes. No directory-wide enumeration
or verification scan runs on a list request.

## Polling is not a permanent command history

Host `maintain()` accepts only `coordination.observe.reconcile`,
`coordination.aggregate` and `coordination.schedule.scan`. These rebuildable
inspections keep the original fenced control transaction, unique schedule-slot
identities and notification preparation, but do not append a command receipt for
each polling UUID. An unchanged `put` does not write either database. Explicit
calls through `command()` still retain their command-id/digest replay contract.
This API must not be extended to task effects, sends, job dispatch or tool calls.

## Read and pagination integration

`get`, normal `list`, receipt replay, task decisions and task events restore full
verified records. Decision/event pages hydrate only their selected rows. Recovery
SQL selects active/starting records before hydration; terminal historical payloads
are not opened just to validate control locks or mark restart state.

Explicit `task.index`, `execution.index`, `coordination.index` queries accept
`after`/`limit` (maximum 100), return `items` and `nextAfter`, and read only bounded
SQL projections, including for old inline bodies. They are metadata APIs, not full
task-detail replacements. Service caches that need full records must hydrate
selected active IDs; they must not silently treat a preview as full authority.

The parallel observer pagination implementation must select page IDs first, then:

- Task detail pages: load `task.get` for the selected IDs, then omit dialogue from
  the response if appropriate. Do not decode an already modified projection.
- Execution detail pages: load `execution.get` only for selected execution IDs.
  Summary pages can use the central bounded `input.title` / backend projection.
- Authorization pages: use indexed task/request IDs, then load only those tasks
  and select the matching full human request. The SQL-generated authorization
  object is intentionally not a full external-detail envelope.
- Coordination/message-context detail pages: hydrate selected records through
  their existing store query APIs. `observer.work-metadata` can keep its narrow SQL
  projection without loading large histories.

Central JSON paths remain available for existing expression indexes and observer
triggers: task/execute IDs and versions; human-request IDs, status and creation
times; last-decision action/question and bounded summary; completion command and
instruction IDs; execution title/backend; coordination command identity, proof
versions, assessment state; schedule action IDs/history timestamps; occurrence
result provenance; and receipt result-task version identity. A reference is never
substituted for an entire SQL-indexed body. Full body decoding must happen before
adding derived page fields: the control-projection digest intentionally rejects
modified envelopes.

## Offline, resumable migration

`scripts/migrate-task-ledger-details.mjs` is an explicit offline utility. It does
not stop processes, change profile configuration, migrate on GET/startup, or delete
source records. Run it only on an approved consistent, closed snapshot; the
`--offline` flag is operator acknowledgement, not automatic proof of quiescence.
It rejects a nonempty source WAL. It reads the source immutable/read-only, creates
a new empty control database, preserves rowids/schema/sequence state, and copies
converted records in bounded transactions. It does not use VACUUM or copy the old
free-page footprint. Native logs and artifacts are not moved or duplicated.

Example paths below are placeholders, not the production profile:

```powershell
node scripts/migrate-task-ledger-details.mjs --offline `
  --source C:/approved/snapshot/tasks.sqlite `
  --source-detail-root C:/approved/snapshot/workspace `
  --destination C:/approved/staging/tasks.sqlite `
  --detail-root C:/approved/staging/workspace --max-rows 1000
# Repeat the same arguments with --resume until complete=true.
```

The source and destination parents must already exist. The API also accepts
`batchSize` (maximum 100) and `maxMilliseconds` (default 30 seconds, checked between
records). A single record's durable write is not forcibly interrupted. Metadata
stores the source identity, destination root, table/rowid cursor, copied counts
and body-byte totals. Changed inputs or an in-use destination are rejected.
The runtime rejects a partially converted destination. Final index/trigger
creation and completion flag commit together. Source content remains intact for
rollback; publication/activation and any later garbage collection are separate
reviewed operations.

Before activation, validate task/receipt/decision/event reads, unknown-operation
fences, notification identity, path ownership and counts against the snapshot.
Preserve the entire matching workspace (native logs, session routes, materials,
outputs and local detail containers) together with the control database and its
initialized marker. This utility converts ledger records; it does not manufacture
a complete workspace backup from a SQLite-only snapshot. No production migration
or physical cleanup has been performed as part of this change.
