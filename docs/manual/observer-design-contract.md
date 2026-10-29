# Observer Design Contract

> 2026-10-29：独立协调功能已移除，协调工作页面、模型配置和所有协调 HTTP 入口退役（410）。下文相关段落仅保留历史合同；Task Owner/普通话题能力继续运行。历史协调数据及审计保留，启动自动结清旧协调等待，不重放通知。
This maintained design/UX equivalent lives under docs/manual rather than root DESIGN.md / UX-CONTRACT.md because project policy places all non-source outputs under docs. Runtime ownership stays in `packages/dingtalk-dsh-observer/web-client.js` and host primitives; this document does not generate or duplicate tokens.

## Product direction

Chinese local operations dashboard inside the DeepSeek Harness host. Users read inputs, recorded coordination decisions, dependencies and verifiable outcomes. Preserve the existing operational reading-room style: quiet surfaces, strong text hierarchy, blue ongoing state, sparse semantic status. No decorative charts, invented percentages or chain-of-thought transcript. The page is not a public-data export; local business content can remain sensitive.

## Canonical ownership

| Capability | Owner | Rule |
| --- | --- | --- |
| Theme | host `--dsw-alias-*`, observer colors | surface/surface2/border/muted/accent/danger/warning; inherited dark theme |
| Typography | host inherited font, observer ui | 12/14/16/20px roles; preserve Chinese fallback; no network font |
| Spacing and shape | observer ui | 4/8/12/16/24px; 8px small,12px panel radius |
| Buttons | host Button | ghost/outline, explicit type, disabled during own request |
| Group filter | existing SelectMenu and host Menu | labelled selection and keyboard behavior |
| Navigation | existing pages/sessionStorage/slots | save only page preference, never fetched content |
| Empty state | existing emptyState | distinguish no rows from failed load and unsupported backend |
| Scoped errors | inline alert + existing Button | retain same-query stale data, recover with explicit retry |
| Status | existing statusTag/StateDot | semantic color plus visible Chinese label, unknown is neutral |
| Scrollbar/focus | observerCss | natural reading scroll, focus-visible outline, no global viewport lock |
| Read-only lists | coordination entity browser | server pagination, explicit row selection, stable detail identity |
| Forms/destructive operations | not introduced | existing task actions remain in owning task screen |

Fallback runtime colors remain #fff surface, #f7f7f8 secondary, #737373 secondary text, #4d6bfe accent, #c33 danger, #a56500 warning. They are existing host fallbacks, not new independently copied palette definitions. Shared runtime tokens are authoritative; do not rebrand one page. Status colors are not categorical chart colors.

## Coordination page contract

Two-column entity list and reading pane on desktop; single column at narrow width. One stable schedule ID survives revisions; direct dispatch batches exclude schedule templates and occurrence-owned members. Source commands are history, not duplicate work rows. Server pagination follows entity construction and result calculation, not source-page deduplication. Default to the first valid group in returned stable order, defer reads while loading, retain explicit all/manual selection through refresh and reset invalid selections synchronously. Empty selected groups stay selected.

Compact two-line rows show a business title and exactly one backend-owned primary result plus time. A quiet selected surface/2px marker remains separate from visible keyboard focus. Actual reminder delivery failure/unknown is prominent, never hidden by accepted input, active plan or completed dispatch job. Task coordination shows prerequisite completion -> target dispatch, never target execution/completion as the coordination result. Show named prerequisite and target links, actual trigger condition, receipt-owned pending/success/failure and actual next step. Task-command notification failure remains a distinct delivery fact under evidence, not target execution failure or a replacement for a known dispatch receipt. Formal prerequisite fulfillment requires the current version-bound proof used by the actual gate. The target task page lists unsatisfied prerequisite tasks with links and the actual all/any contract; unsupported any-of is never invented. Internal proof sentences are removed from next-action text and retained only in evidence disclosure. Detail shows the relation and dispatch result before history. Pausing/cancelling describes future control and cannot erase past effects; recurring enabled and latest delivery failure can coexist. Only recorded nextDue/retry timestamps promise future scheduling; absent records explicitly say no recorded arrangement. Unknown raw states are neutral, never successful/running.

Source input/history, earlier occurrences, member evidence and read boundaries use native collapsed details. No empty sections. Keep action and delivery facts independent under disclosure. Every bounded collection exposes truncation, with primary results calculated from full collections. Exact dependency IDs resolve to visible member names when available, never guessed task identities.

Each async scope owns loading/error/freshness. Changing filter or selection clears unrelated old data synchronously in visible projection. Late responses cannot paint another selection. Refresh every five seconds and manual retry use independent coordinator requests, not the general overview Promise.all. Same-selection refresh failures keep readable data labelled stale; first failure never becomes an empty success. No full-page loading mask over existing readable data.

All returned content is rendered as text. No raw HTML, auto-linked evidence, actor/recipient identities, prompts, credentials or incidental raw ledger objects. No content is stored in local/session storage. Do not infer hidden thoughts from proposal/history or claim evidence was independently verified because it exists.

Keyboard focus is visibly retained and restored to entity selection on return from narrow detail. Controls have stable accessible names. Preserve host reduced-motion and forced-colors conventions. No new autonomous animations, modal, chart or design-system primitive is needed.

## Inbox processing contract

Backend `processingState` owns the current message-version result. Missing group topics or `routingStatus=routed` is never proof of completion. Use the existing table and status primitives for routing, failed, processing, semantic completion and neutral unknown. Semantic completion is independent from business Task completion, source settlement and notification delivery. Never infer historical success from missing timing.

Keep the compact conclusion/duration line; disclose version-bound clocks and delivery facts through keyboard-accessible native details. Negative clocks are anomalies, missing clocks remain unrecorded, terminal durations never use the current clock. Occurred-to-semantic is not queue/model latency. Received-to-all-linked-notifications E2E requires precise source-version binding and actual readback; ACK is not delivered. Shared/overlapping stages are not summed. Retain the existing narrow-table horizontal reading behavior; no new page-wide scroll or visual redesign.

## Verification

Relevant observer tests and live isolated browser acceptance own behavior verification. Desktop, narrow 390px, keyboard, loading/empty/error/retry, stale and real HTTP-to-SQLite refresh are required for coordination changes. Static source assertions alone do not prove browser rendering. Host-adapter acceptance is explicitly distinct from installed-host deployment testing.
