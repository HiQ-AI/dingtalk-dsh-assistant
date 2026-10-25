# Round 18

2026-10-25. Isolated actual React/primitives/production HTTP/task service/SQLite acceptance, not installed-host deployment. The nine reminder fixtures are seeded only through official store commands with no model or transport capability. They cover single failed/delivered/unknown/pending, recurring failure with real nextDue, paused failure, and cancelled failure/delivered/unknown. All nine are asserted in both API result and rendered detail. Desktop light passed six cases: stable entity dedup/original failure, default group with no all-query, result/next-step/disclosure/focus, nine scenarios, task-return/manual/5s refresh and zero console/API errors/mutations/overflow. Screenshot `after-desktop-light-failed-reminder.png` personally inspected: failure primary, separate plan and no next-trigger/retry legible.

- Intermediate cancellation FAIL is retained in round17, not overwritten.
- `node --test test/coordination-observer.test.js test/observer-node-control-display.test.js`: initial integration68/68PASS (later final rerun required after review changes).
- Risk regression135/135PASS: observer-client, slot-compatibility, board-restoration, archive-interaction, restart-web, coordination-trigger-commands, notification-freshness, schedule-revisions, final-fault-matrix and concurrency-contracts.
- Release smoke first run in Git Bash selected GNU tar, which interpreted Windows drive C: as a remote host and failed3 archive tests;9PASS/3FAIL/2SKIP retained. Native PowerShell rerun12PASS/0FAIL/2SKIP; skips require full native dsh-base profile. No test assertion was weakened.
- Suite mapping308 files exactly once; historical3.

Fixture host manifest is outside the checkout under `$CLAUDE_JOB_DIR/tmp/ledger-isolated-18/manifest.json`; launch with existing browser deps root and exact esbuild module `D:/soft/node-v16.20.2/node_cache/_npx/fd45a72a545557e9/node_modules/esbuild/lib/main.js`. Use a fresh runtime directory for regeneration. Production3080 has not been changed by this round.

## Final Integration Before Freeze

`node --test test/coordination-observer.test.js test/observer-node-control-display.test.js test/observer-client.test.js test/observer-slot-compatibility.test.js test/observer-board-restoration.test.js test/observer-archive-interaction.test.js test/restart-web.test.js` ->130PASS/0FAIL/0SKIP. This supersedes the earlier68/69 directed snapshots without erasing them. Source/HTTP/member proofs include real SQLite cancel-after-failed, cancel/pause after formal task completion, unknown plan state, version-bound completion, next-step separation and historical safe schedule revisions.

Release smoke must run in PowerShell7 with native Windows tar; do not launch that Windows-path archive test through Git Bash GNU tar. Correct command: `pnpm test:release-smoke; if ($LASTEXITCODE) { throw "release smoke failed" }`. Mapping: `node scripts/test-suites.mjs check`.
