# Coordinator Work Visualization

## Goal

Deliver a real API-backed entry in the existing Web observer so users can inspect received coordinator inputs, recorded decisions (not hidden chain-of-thought), tasks/dependencies, execution and waiting/blocking outcomes, and available evidence. Preserve existing capabilities. Initial isolated delivery did not modify deployment. On 2026-10-25 the user authorized PR258 merge, local dual-package deployment and read-only real 3080 host acceptance. Sending DingTalk messages, replaying notifications and business data writes remain prohibited.

## Sub Goal Matrix

| ID | Sub goal | Status | Evidence |
| --- | --- | --- | --- |
| G1 | Latest source, isolated worktree and actual capability inventory | PASS | origin/main c23a39a, PR257 merged; shared-tasks.md |
| G2 | Grounded UI/domain/API design and sensitive-data boundaries | PASS | docs/spec/coordinator-work-visualization.md; docs/manual/observer-design-contract.md |
| G3 | Focused implementation using existing UI primitives and real data | PASS | Production source-driven API/service/resident + CoordinationBrowser; 167/167 final relevant regression and package whitelist PASS |
| G4 | Relevant tests plus isolated browser core/mobile/empty/error acceptance | PASS | round-3: 6 real Chrome variants PASS; current-source hash matches; task-service return and production-command polling verified; round-2 failure preserved |
| G5 | Final review, clean scoped commit and independently read PR | PASS | 6c495d09a3c30381f29558a0068bb1ef88d2d910 pushed; gh readback PR258 OPEN, main <- worktree-coordinator-work-visualization; report.md |
| G6 | Authorized merge and native local dual-package deployment | PASS | PR258 MERGED22d5738; original deploy exit1/start timeout preserved, same91732 later ready without reinstall/restart; dual-package hashes/versions/profile/native drain/health independently verified; round-6/deployment-readback.json |
| G7 | Read-only actual 3080 host acceptance and final deployment evidence | PASS | Actual default-light desktop/mobile each11 PASS,18 existing records,dependencies/proofs/task return/polling/filter/390px,errors0/mutations0; round-6. Actual installed dark unverified; preserve Host settings |
| G8 | Deliver startup wait fix and final evidence in new follow-up PR | IN PROGRESS | Source-only wait300->600s,11 targeted tests PASS; original merged implementation branch not pushed |

## Decisions and Important Information

- 2026-10-25: Original lead remains sole deployment owner. Evidence branch worktree-coordinator-work-deployment starts at merge22d5738; never push the merged implementation branch. Package source remains frozen during deployment.
- 2026-10-25: task-session runtime has no workflow maintenance API (GET404); follow task-session-clean-start.md native disposal script, not historical workflow Bootstrap. Verify autostart/inbound restored; do not invent a maintenance resume receipt.

- 2026-10-25: Latest fetched main includes PR257; do not cherry-pick or rerun coordinator-sequential-validation.
- 2026-10-25: Main checkout contains user changes; only this worktree is writable for this task.
- 2026-10-25 correction: native named Agent teammates ARE available (Agent with name/team_name/effort; ListAgents lists Teammates). coordinator-api and coordinator-ui-review are created at explicit low effort. Only visualization-worker type was lost from registry; actual general-purpose substitute and unverified lead runtime effort remain explicit. Workflow research is not counted as native team activity.
- Browser verification must start the current source in an isolated port/data root and prove live HTTP data, not static mock UI. Any synthetic fixture is labelled test data.
