# Observer Design Contract

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
| Read-only lists | coordination source browser | server pagination, explicit row selection, stable detail identity |
| Forms/destructive operations | not introduced | existing task actions remain in owning task screen |

Fallback runtime colors remain #fff surface, #f7f7f8 secondary, #737373 secondary text, #4d6bfe accent, #c33 danger, #a56500 warning. They are existing host fallbacks, not new independently copied palette definitions. Shared runtime tokens are authoritative; do not rebrand one page. Status colors are not categorical chart colors.

## Coordination page contract

Two-column source list and reading pane on desktop; single column at narrow width. Lists and details wrap long business text, avoid horizontal page overflow and use semantic headings/list structure. Exact predecessor instruction IDs resolve to visible task names when available; unresolved references remain explicit, never interpreted as task IDs. Section order: input, recorded acceptance/change decisions, tasks/dependencies, scheduled action/delivery, evidence boundaries. Completion comes only from backend authoritative snapshot/proof. Applied means accepted, not completed.

Each async scope owns loading/error/freshness. Changing filter or selection clears unrelated old data synchronously in visible projection. Late responses cannot paint another selection. Refresh every five seconds and manual retry use independent coordinator requests, not the general overview Promise.all. Same-selection refresh failures keep readable data labelled stale; first failure never becomes an empty success. No full-page loading mask over existing readable data.

All returned content is rendered as text. No raw HTML, auto-linked evidence, actor/recipient identities, prompts, credentials or incidental raw ledger objects. No content is stored in local/session storage. Do not infer hidden thoughts from proposal/history or claim evidence was independently verified because it exists.

Keyboard focus is visibly retained and restored to source selection on return from narrow detail. Controls have stable accessible names. Preserve host reduced-motion and forced-colors conventions. No new autonomous animations, modal, chart or design-system primitive is needed.

## Verification

Relevant observer tests and live isolated browser acceptance own behavior verification. Desktop, narrow 390px, keyboard, loading/empty/error/retry, stale and real HTTP-to-SQLite refresh are required for coordination changes. Static source assertions alone do not prove browser rendering. Host-adapter acceptance is explicitly distinct from installed-host deployment testing.
