# Coordinator Work Visualization

Date: 2026-10-25. Pre-implementation design snapshot; progress lives only in `docs/acceptance/coordinator-work-visualization/shared-tasks.md`.

## Goal and verified baseline

Add a usable read-only **协调工作** page to the existing observer, not a separate diagram/app. It must explain persisted input, recorded decisions, task dependencies, real outcomes and evidence, without inventing internal reasoning. Base is fetched origin/main `c23a39a`, which includes merged PR257. Shared installed runtime is neither modified nor claimed to match this worktree. Old coordinator-sequential-validation is a different completed task.

## Current implementation

- `packages/dingtalk-dsh-observer/web-client.js`: React ModuleLoader client, host sidebar/main slots, six page tabs, primitives Button/Menu/StateDot, shared colors/ui/statusTag/emptyState. Existing TopicBrowser is the comparable master/detail workflow. Host-derived typography and light/dark tokens stay unchanged.
- `packages/dingtalk-dsh-assistant/http.js`: loopback GET API and Origin/Host boundary; no coordination-domain read endpoint. Existing workflow trace is not a complete coordination ledger.
- `dynamic-task-store.js`: coordination.source.list, coordination.list/get, schedule/occurrence/job.list, task.get are real SQLite reads. Source rows include reserved, rejected, unresolved and failed-to-accept inputs, so lists must be source-driven.
- `coordination-ledger.js`: dependencies refer to instruction IDs, not task IDs. Applied commands are not completed tasks. `completionProof` is version-bound formal evidence, not an execution claim.
- `coordination-summary.js:coordinationSnapshot` owns aggregate state, including recurring schedules, clarification, partial completion and delivery uncertainty. Reuse it rather than implementing a second completion algorithm in React.
- `task-session-service.js` exposes task DTOs; `resident.js` connects service reads to HTTP runtime.

## Scope and ownership

Lead owns observer UI, focused UI tests, documentation, integration and final delivery. Native teammate coordinator-api owns read-only projection/service/runtime/HTTP and focused backend tests. coordinator-ui-review independently reviews delivered UI and browser evidence. No concurrent editing of a file; shared progress ledger is lead-only. Existing completed auxiliary workflow research is reused, not rerun.

Named native Agent teammates with explicit effort low are available despite absent TeamCreate. Requested visualization-worker type was removed from current tool registry; actual general-purpose teammate type and lead effort-verification limitation are recorded, not disguised as equivalent configuration.

## Read-only API design

Introduce a bounded paginated source list and a source detail endpoint under `/state/coordination-sources`. Accept only `groupId`, `offset`, `limit`; validate safe integers and cap limit. Detail selection uses source ID; coordination is nullable. Return observedAt as an observation window marker, not a transactional-snapshot guarantee. Unsupported service returns 503, missing source 404, invalid paging 400.

- List: source identity, group identity, original business input, timestamp, persisted source state/settled, optional coordination ID and accepted kind/revision. Include rejected/unattached inputs.
- Detail: whitelisted source; coordination identity/revision/state and bounded recorded change history; aggregate state from coordinationSnapshot; members with instruction IDs/task IDs/title, explicit dependency IDs, current instruction/task state, waiting/blocking reason and task last recorded decision/evidence; completion-proof references; safe schedules/occurrences/jobs with action and delivery state kept separate.
- Unrecorded decision/evidence stays explicitly absent. No synthesized chain-of-thought. Unknown states get a neutral label rather than guessed success.
- Lists paginate server-side; detail collections must report any truncation. API doc contains final implemented exact field names.

## Privacy and security boundary

Reuse existing loopback Host/Origin checks; no new auth or write operations. Construct DTOs field by field, never spread source, task, command, acceptedProposal, model object or raw ledger row. Do not expose actor/recipient IDs, model prompts, credentials, leases, raw error messages or environment paths through incidental object fields. Original input, requirements and recorded summaries/evidence may themselves contain sensitive business data: this is the same local privileged observer audience, not a public/redacted export. Render all business text as plain React text, never HTML or automatically navigable evidence links. Frontend does not log/store content or copy it to browser storage. No Artifact publication of sensitive runtime records; repository/PR is the requested delivery surface.

## Information architecture and behavior

New tab **协调工作** uses existing page navigation. List filters by group and pages 10 rows. A selected input opens an inline reading panel; at narrow width list/detail stack with a labelled back action and focus management. Reuse Button, SelectMenu, statusTag and emptyState. No chart/KPI theater: dependencies are explicit accessible lists of predecessor names/IDs, which convey the mechanism without an ambiguous DAG.

Detail sections: **收到的输入**, **已记录的判断与变更**, **任务与依赖**, **定时安排与触发**, **完成证据与边界**. Recorded source acceptance is separate from execution. Show task details via the existing task navigation and return path, never manufacture workflow run IDs. Structured IDs appear only as text audit references.

| State | Visible result | Recovery |
| --- | --- | --- |
| Initial loading | Scoped status, no false empty state | Wait or retry |
| Empty | No recorded coordinator inputs for current group | Change group / refresh |
| List failure | Persistent inline alert; retain same-query rows labelled stale | Explicit retry |
| Detail failure | Retain only same-selection stale detail | Retry; back to list |
| Group/selection change | Clear previous query/detail immediately | New request; ignore old response |
| Refresh | Independently refresh list/detail every 5s and manual button | Abort on cleanup, single in-flight request per scope |
| Unattached/rejected | Persisted input and explanation; no fake coordination | Read-only |
| Unsupported backend | Explicit feature unavailable, not empty success | Upgrade/restart outside this task |
| Long text | Wrap anywhere; preserve line breaks | Natural page scrolling |

Independent coordination fetching must not be added to the existing overview Promise.all. Last success time comes from actual API data; failures do not advance it. Loading must not hide readable same-selection data. Abort and active-generation guards prevent late response contamination. Polling continues when overview calls fail. The screen is read-only; no retries of business commands or notifications.

## Visual context and accessibility

Product/admin register; Chinese existing application, no Japan-specific domain inferred. Preserve host typography, blue running state, semantic success/warning/error, 8/12px radius, existing page max width, section borders, no global token redesign. Runtime `colors`, `ui`, shared primitives and observerCss remain canonical; maintained equivalent design/UX notes go in `docs/manual/` to satisfy the repository ban on non-source root files. Use semantic headings/lists, explicit text with status color, focus-visible, labelled controls, reduced-motion support, 390px viewport and keyboard verification. No categorical chart palette is introduced.

## Verification and delivery

Use pnpm frozen-lockfile in the worktree. Run focused backend projection/HTTP and observer tests plus impacted coordination regressions, not full suite or CI. Start an isolated server with real SQLite store, real production HTTP handler and actual ModuleLoader observer in a browser host adapter; any seeded local acceptance data is labelled synthetic and created through production store commands, not mocked API responses. Keep ports/data isolated; do not connect resident 18998, real credentials or DingTalk transport. Verify source list/detail/dependencies/evidence, task navigation, refresh from changed SQLite data, empty, error, slow-response isolation, narrow screen and keyboard. Capture screenshots and request/response evidence under round directories; large binaries stay untracked with rerun recipe. Browser host-adapter limitations are explicit, not claimed as full installed-host deployment acceptance.

`matrix.csv` is case-by-round truth. Fix/rerun adds a new round file. Report only after green. Read write-pr skill before scoped commit/push/PR; read PR state before push and independently reread URL/number/state after. Do not merge, push main, force-push, trigger CI, modify shared installation or send DingTalk messages.
