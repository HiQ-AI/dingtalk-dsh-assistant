# Coordinator Work Visualization

## Goal

Deliver a real API-backed entry in the existing Web observer so users can inspect received coordinator inputs, recorded decisions (not hidden chain-of-thought), tasks/dependencies, execution and waiting/blocking outcomes, and available evidence. Preserve existing capabilities. Never modify shared deployment or send DingTalk messages for this work.

## Sub Goal Matrix

| ID | Sub goal | Status | Evidence |
| --- | --- | --- | --- |
| G1 | Latest source, isolated worktree and actual capability inventory | PASS | origin/main c23a39a, PR257 merged; shared-tasks.md |
| G2 | Grounded UI/domain/API design and sensitive-data boundaries | PASS | docs/spec/coordinator-work-visualization.md; docs/manual/observer-design-contract.md |
| G3 | Focused implementation using existing UI primitives and real data | PASS | Production source-driven API/service/resident + CoordinationBrowser; 167/167 final relevant regression and package whitelist PASS |
| G4 | Relevant tests plus isolated browser core/mobile/empty/error acceptance | PASS | round-3: 6 real Chrome variants PASS; current-source hash matches; task-service return and production-command polling verified; round-2 failure preserved |
| G5 | Final review, clean scoped commit and independently read PR | IN_PROGRESS | Review complete; no confirmed findings. Original lead recovered from response-stream error, read back existing artifacts/ports/remote PR before proceeding; scoped commit/push/PR next |

## Decisions and Important Information

- 2026-10-25: Latest fetched main includes PR257; do not cherry-pick or rerun coordinator-sequential-validation.
- 2026-10-25: Main checkout contains user changes; only this worktree is writable for this task.
- 2026-10-25 correction: native named Agent teammates ARE available (Agent with name/team_name/effort; ListAgents lists Teammates). coordinator-api and coordinator-ui-review are created at explicit low effort. Only visualization-worker type was lost from registry; actual general-purpose substitute and unverified lead runtime effort remain explicit. Workflow research is not counted as native team activity.
- Browser verification must start the current source in an isolated port/data root and prove live HTTP data, not static mock UI. Any synthetic fixture is labelled test data.
