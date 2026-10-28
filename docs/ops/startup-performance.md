# Startup phases and responsiveness

The task ledger still passes `quick_check` and `foreign_key_check` before owner recovery. These full checks now run on a read-only SQLite snapshot in a worker, rather than synchronously blocking the Host event loop. Failure or an abnormal worker exit rejects startup. No prior successful check is cached, no historical task data is deleted, and this change does not introduce a storage migration.

The Host still owns schema/instance/epoch validation, the owner transaction, unknown-operation recovery, and resource-lock validation. The transaction reuses its execution and operation snapshots instead of re-reading the same JSON records for each invariant. It never reuses those snapshots across commands or recovery rounds.

`startup` log records contain only phase names, elapsed/duration milliseconds, status and aggregate counts. They cover transport storage, environment inspection, task integrity, task owner recovery, service cache loading, the first recovery round, the resident listener and the first healthy DWS bridge observation. They omit paths, task identities, business content, credentials and error messages. An observer failure cannot change startup behavior.

`openDynamicTaskStore` and `openTaskSessionService` accept an optional `startupObserver(sample)` callback. Storage integrations should preserve this optional callback when forwarding arguments. No configuration flag, automatic migration, retries or new operator gate is required.

## Regression evidence and limits

`test/task-startup-performance.test.js` checks event-loop responsiveness during a 32 MiB synthetic history scan, corruption and foreign-key rejection, failure-safe timing observations, and 513 completed execution records retaining their original result after startup recovery. These fixtures are independent of production data. Their timing diagnostics are measurements of the fixtures, not claims about the live service.

Moving the mandatory scan off-thread does not reduce the bytes that SQLite must validate. Large databases may still delay task readiness, while other independently initialized Host capabilities can continue to respond. Detail externalization and indexed pagination belong to their separate storage migrations. Do not enable those migrations implicitly during ordinary startup.

## `sessionController` unavailable

The installed DSH gateway throws `gateway/service-unavailable` before calling `session/create` when `receiverContext.get('sessionController')` is absent (`@deepseek-ai/dsh-api-gateway/lib/index.js`, receiver dispatch). The controller is supplied by `@deepseek-ai/dsh-api-session-controller`, with core dependencies including sessions, sessionQuery and workspaceRegistry. This plugin does not register or replace that controller.

A screenshot alone cannot distinguish a pending dependency, failed activation, disposed controller or stale remote definition. On 2026-10-28 at 08:13 UTC the existing resident health endpoint returned `inboundProcessing=true` and a healthy DWS bridge; its startup log contained no activation error. Those observations do not establish controller health. No business session was created to probe it, and no live service was restarted. Check the DSH Loader's read-only activation/dependency state for the controller and its prerequisites before changing bootstrap or adding retries. The off-thread task scan addresses confirmed Host blocking, but is not evidence that this separate controller error is fixed.
