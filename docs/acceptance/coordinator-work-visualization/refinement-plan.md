# Coordination Reading Refinement

2026-10-25. User-feedback iteration on OPEN PR259; prior rounds remain historical. Lead owns integration and state ledgers.

## Observed Baseline And Scope

Actual installed3080 screenshot/data in round-7: first group in returned order has10 sources,7 schedule sources,no task-bearing sources. Baseline automatically reads all groups once before manual filtering. At1440x1000 fully visible rows5,390x844 rows4; row heights111-153px. Original text occupies up to3 lines,group name repeats in every card,heavy selected border competes with content. Current detail opens raw input first and displays empty task/schedule/technical sections.

Only CoordinationBrowser and its scoped CSS change. Reuse native SelectMenu/Button/status tokens and task route. No all-site typography,backend schema or business mutation change.

## Design Decision

An operations reading list,not a card gallery. Inherited host type12/14/16/20px; surface #fff,secondary #f7f7f8,muted #737373,accent #4d6bfe,border host token. Dark inherits host tokens. Compact rows have one title line and one status/time line,8px vertical/12px horizontal padding,2px list gap,soft selected secondary background and2px inset marker. Keyboard focus has its own accent outline; mouse selection is not a thick outline.

Desktop: group toolbar; narrow source list | focused content. Mobile: list then drill-through detail with existing return. Avoid decorative cards/metrics; use content type as hierarchy.

Schedule sources: status,next trigger,actual once/daily/weekly rule and timezone first. Dispatch sources: actual task state and instruction state,dependency names,blocker and next action grounded only in waiting/control/state fields; recent decision summaries remain separately labelled historical conclusions. Mixed content shows both; unassociated/clarification/rejection shows saved result without fabricated tasks. Raw input,saved change history,evidence and reading boundaries are collapsed native details. Empty sections are absent. Notification delivery never serves as completion.

## Selection State

`groupsReady` distinguishes loading from loaded-empty. Deduplicate valid nonblank groupId in original order. Uninitialized selection is not all: request path null until first valid group known. Explicit all stays available but is never implicit. On invalidated selection derive first valid group synchronously and clear old source/page before reads; on temporary overview refresh retain loaded group data. No-groups shows an explicit empty state and no unfiltered fetch. Empty selected group stays selected; never skip it because it has no coordinator sources. Task return restores only valid scope. User selection survives reordered groups,manual/poll refresh and async completion.

## Verification And Deployment

round-7 before screenshots and machine row counts retained. Subsequent fresh rounds: component async race/empty/invalid/all/refresh/return tests; real current-source React/primitives/service/SQLite desktop/mobile/light/dark schedule and task details; same native1440x1000/390x844 after density; actual installed candidate after native script Check and fixed package/profile/PID pins. Freeze package source during pack/install verification. Independent native low reviewer audits final diff and findings closed by tests. Do not merge PR259,send DingTalk,replay notifications or modify business rows. Record every failure in matrix and new round; no overwritten evidence.
