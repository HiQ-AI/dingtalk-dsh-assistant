# Round 2

2026-10-25. Final backend and initial real-browser verification in the isolated worktree. No shared deployment, live business state or DingTalk operations.

## PASS evidence

- Combined relevant regression: `node --test --test-concurrency=4 test/coordination-observer.test.js test/http.test.js test/task-session-http-integration.test.js test/observer-client.test.js test/observer-slot-compatibility.test.js test/observer-board-restoration.test.js test/observer-node-control-display.test.js test/observer-archive-interaction.test.js test/coordination-summary.test.js test/coordination-ledger.test.js test/coordination-effective-graph.test.js`: 167 tests, 167 PASS, 0 FAIL/cancelled/skipped. This supersedes the partial pre-refinement runs in round-1; their counts are not additive coverage.
- `node scripts/test-suites.mjs check`: verified 308 files, every file exactly once, historical 3, deleted 0.
- `npm pack --dry-run --json` for the Assistant package: includes the new production `coordination-observer.js`; no package published.
- Independent read-only review workflow `wf_064ed33a-27d` completed: backend and frontend reviewed; no confirmed defect remained after adversarial verification. A proposed permanent-refresh-disable issue was refuted by the null-path loading identity guard and subsequent request lifecycle. This is auxiliary review, not native team evidence. Runtime/concurrency, complete-host permissions and live deployment remain outside that review.
- Native coordinator-ui-review drove actual Chrome, React 18.3.1, more than 100 native primitive exports, production HTTP and a newly seeded isolated SQLite store. Desktop-light run reported 10 passing scenarios: native host adapter/HTTP, real pagination, reserved/rejected/clarification detail and focus, formal proof, dependencies/waiting, empty-group filter/reset, request-abort stale state and network recovery. Formal evidence: [desktop-light results](round-2/desktop-light-results.json), [list screenshot](round-2/desktop-light-list.png), [detail screenshot](round-2/desktop-light-detail.png). Teammate inspected both screenshots; lead independently opened the detail screenshot and confirmed readable dependencies, waiting/completion distinction and evidence boundaries. Dark desktop also passed the same ten cases: [results](round-2/desktop-dark-results.json).
- Independent empty database (not merely a filter): Web 19089/API 19090, fresh `browser-empty-1`, expected total 0. Native adapter/HTTP and empty-store passed. Evidence: [empty-store results](round-2/empty-desktop-light-results.json), [screenshot](round-2/empty-desktop-light-list.png).

## Evidence location and integrity

- Formal team output is this worktree's `docs/acceptance/coordinator-work-visualization/round-2/`. Earlier jobs/tmp paths were runtime staging, not the delivery root. Lead copied the nine existing necessary PNG/JSON files into this round, then independently enumerated lengths and SHA256 with `Get-ChildItem` and `Get-FileHash`.
- [Evidence inventory](round-2/evidence-inventory.json) records each relative path, bytes and SHA256. All nine copied files match the recorded hashes and lengths. PNGs are locally retained but gitignored; small result JSON and the inventory are versioned. Round-3 owns post-fix output, so the round-2 failure is preserved.
- Only ephemeral dependency installation, live SQLite and process/runtime files may remain in jobs/tmp. Browser output is being constrained to an explicit `round-N` directory under the formal acceptance root. Re-generation commands are in round-3; a re-run produces a new timestamp/database and is not claimed to reproduce historical PNG byte hashes.

## FAIL evidence: mobile header

- Actual Chrome at 390px: observer clientWidth 390, scrollWidth 394; header first row and nav right edge 393.5625px. Document-level overflow alone had missed this local overflow. The stronger observer-width assertion failed; mobile is FAIL in this round.
- Root cause: the existing header grid's auto minimum combined with a fixed-height first row and non-wrapping status cluster. Padding plus intrinsic content required 393.56px.
- Lead changed only the header constraints: explicit `minmax(0, 1fr)` grid column, first row `minHeight` instead of fixed `height`, status cluster wrapping. Refresh is not hidden or clipped; nav remains a local horizontal scroller.
- Immediate post-fix `node --check` PASS and observer-client + observer-node-control-display regression: 63 PASS, 0 FAIL/cancelled/skipped. The browser fix-rerun belongs to round-3, not this round.

## Pending for the next round

Desktop/mobile light+dark after the header fix, actual task-service drill-through/return, production-command-backed polling refresh, final source hashes and direct evidence inspection. Complete installed-host verification and shared deployment are explicitly not claimed. No pre-change screenshot baseline exists.
