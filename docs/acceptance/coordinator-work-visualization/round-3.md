# Round 3

2026-10-25. Fix-rerun of round-2 mobile header failure, using the final worktree source. Do not replace round-2 failure evidence. Matrix is the case-by-round authority.

## Verified browser results

Native teammate coordinator-ui-review launched fresh isolated stores and drove real Chrome. Lead subsequently read the persisted results and independently verified all six source hashes/lengths in each report (36 checks), and all ten PNG hashes/lengths (1,009,890 bytes total). All matched current files. Each report records launchCommand, hostPid, dataRoot, sourceHashes, HTTP evidence and PNG hashes. No tests were replayed to recover from a response-stream interruption.

| Run | Result | Cases | Evidence |
| --- | --- | --- | --- |
| Seeded desktop light, 1440x1000 | PASS | 13 | [JSON](round-3/seeded-desktop-light-results.json), [list](round-3/seeded-desktop-light-list.png), [detail](round-3/seeded-desktop-light-detail.png) |
| Seeded desktop dark, 1440x1000 | PASS | 12 | [JSON](round-3/seeded-desktop-dark-results.json), [list](round-3/seeded-desktop-dark-list.png), [detail](round-3/seeded-desktop-dark-detail.png) |
| Seeded mobile light, 390x844 | PASS | 12 | [JSON](round-3/seeded-mobile-light-results.json), [list](round-3/seeded-mobile-light-list.png), [detail](round-3/seeded-mobile-light-detail.png) |
| Seeded mobile dark, 390x844 | PASS | 12 | [JSON](round-3/seeded-mobile-dark-results.json), [list](round-3/seeded-mobile-dark-list.png), [detail](round-3/seeded-mobile-dark-detail.png) |
| Independent empty SQLite desktop light | PASS | 2 | [JSON](round-3/empty-desktop-light-results.json), [list](round-3/empty-desktop-light-list.png) |
| Independent empty SQLite mobile dark | PASS | 2 | [JSON](round-3/empty-mobile-dark-results.json), [list](round-3/empty-mobile-dark-list.png) |

These are repeated scenario executions across variants, not 53 unique tests. Populated stores have 25 sources with accepted/needs_clarification/rejected/reserved states. Empty-store runs use a separate database, not a group filter.

- All four populated variants cover pagination, reserved/rejected/clarification detail, heading focus and return-source focus, formal proof, dependent waiting vs acceptance/completion, actual production task-service DTO drill-through and source return, empty group/page reset, real network abort stale warning and recovery.
- Desktop light additionally verifies a real production `coordination.source.failed` command on the host-owned SQLite connection and observes the changed detail via 5-second polling. No response data is fabricated. The mutation endpoint exists only in the synthetic harness, not the production API, and rejects sources outside the labelled synthetic group.
- Both desktop variants delay consumption of a real fetch response by 1.2 seconds and prove that the previous selected source cannot overwrite the new selection. This is browser behavior in addition to component cancellation tests.
- Mobile variants assert both document width and observer scrollWidth <= clientWidth. The old 394/390 overflow no longer reproduces after minmax(0,1fr), minHeight and wrapped status layout. Navigation intentionally remains a local horizontal scroller.
- Real task service produces `/state/tasks/synthetic-A/detail`: HTTP 200, timeline.version=1, state=running; the browser opens its actual task details, then returns to the selected coordination source (desktop also asserts page 3).
- Invalid `limit=0` produces HTTP 400 with `coordination_query_invalid`; list reads return HTTP 200 and the expected count.
- Lead directly opened final mobile light/dark details, desktop dark detail and empty light list. Text, controls, waiting/completion distinction and boundaries remain readable; refresh is visible without clipping. Teammate additionally inspected desktop light and all main variants. There is no fabricated pre-change screenshot baseline.

## Regression and packaging

Final source regression after the header fix: the 11-file command in round-2 ran again and returned **167 PASS, 0 FAIL/cancelled/skipped**, 13.566 seconds. `node --check` passed. Suite-map check reports 308 files, each exactly once, historical 3, deleted 0. `git diff --check` passed.

Assistant `npm pack --dry-run --json`: version 2.1.0, 70 files, projection present (7398 bytes). Observer dry-run: version 2.1.0, 4 files, web-client.js present (251275 bytes). No package was published.

[Strict frontend audit](round-3/premium-audit.json): findings=[], errors/warnings/violations/unresolved=0. Teammate confirmed the tool's default root output was theirs and moved it here. Lead independently confirmed the root premium-audit.json is absent. Static audit does not replace browser proof.

## Formal artifact boundary

- All permanent results, screenshots, summaries and reusable scripts are under this worktree's `docs/acceptance/coordinator-work-visualization/`.
- PNGs remain local and gitignored; six small result JSONs and the audit are tracked. Each result carries its PNG lengths/SHA256 and six source lengths/SHA256.
- Browser script defaults output to round-3; an explicit output must resolve under this acceptance root and have a round-N basename. Lead independently executed external and non-round output rejection probes: both exit 2 before network/filesystem output. Host `--check` passed without creating a data root or listener.
- Only live SQLite, dependency installation, resident runtime data and process staging belong in jobs/tmp. They are not the formal deliverable. Historical runtime roots/PIDs remain in JSON as provenance, not instructions to reuse them.
- Owner stopped seeded PID90020 and empty PID33872. Lead independently found zero listeners on 19087-19090. Current native roster is idle; no new lead/session was created.

## Re-generation recipe (PowerShell 7)

Run at this worktree root with Node 24+, pnpm frozen dependencies, Chrome and Python Playwright. Choose a NEW runtime root and a NEW round-N output for another verification round. Reusing historical filenames can overwrite evidence; do not rerun into round-2 or round-3.

```powershell
pnpm install --frozen-lockfile
$base = 'docs/acceptance/coordinator-work-visualization'
$deps = Join-Path $env:CLAUDE_JOB_DIR 'tmp/browser-deps-new'
& "$base/scripts/prepare-browser-deps.ps1" -DependencyRoot $deps -Check
& "$base/scripts/prepare-browser-deps.ps1" -DependencyRoot $deps
$esbuild = Join-Path $deps 'node_modules/esbuild/lib/main.js'
$data = Join-Path $env:CLAUDE_JOB_DIR 'tmp/browser-seeded-new'
node "$base/scripts/isolated-browser-host.mjs" --data-root $data --deps-root $deps --esbuild-module $esbuild --check
node "$base/scripts/isolated-browser-host.mjs" --data-root $data --deps-root $deps --esbuild-module $esbuild
```

The final command holds the isolated server; in another terminal in the SAME worktree, choose an unused round number:

```powershell
$out = 'docs/acceptance/coordinator-work-visualization/round-4'
$driver = 'docs/acceptance/coordinator-work-visualization/scripts/browser-acceptance.py'
& D:/soft/Python312/python.exe -I $driver --output-dir $out --mutate
& D:/soft/Python312/python.exe -I $driver --output-dir $out --theme dark
& D:/soft/Python312/python.exe -I $driver --output-dir $out --mobile
& D:/soft/Python312/python.exe -I $driver --output-dir $out --mobile --theme dark
```

For independent empty state, start the host with a NEW data root, `--empty --web-port 19089 --api-port 19090`, first with `--check`; drive with `--web http://127.0.0.1:19089 --api http://127.0.0.1:19090 --expected-total 0` and optional `--mobile --theme dark`. Stop only these owned processes with Ctrl+C. Re-generated timestamps/IDs/PNG byte hashes naturally differ from historical artifacts.

## Review and unverified boundaries

Independent read-only backend/frontend review completed with no confirmed finding; the alleged permanent disabled-refresh issue was refuted against cleanup and null-path loading guards. Two extra native package tests in an earlier separate attempt were skipped because a complete @deepseek-ai/dsh-base profile was absent; they are not included in the 167/167 result and not represented as passed.

The adapter uses real React18/primitives, production HTTP/SQLite and real task service reads, but minimal ModuleLoader/slots/session navigation. Complete installed-host deployment, real model execution and DingTalk send/reconcile are NOT verified and were not authorized. No shared deployment, business message, notification retry, CI dispatch, merge, main push or force-push occurred.

## Response-stream recovery

Supervisor reported `API Error: The response stopped arriving`. Lead recovered in the original session, read the existing round-3 reports, native roster, ports and remote PR state before any write/retry. Round-3 was already complete and ports closed; remote query returned no PR. Current tool responses succeeded. Remaining work at this checkpoint is scoped commit/push/PR creation and independent readback, not more browser/research runs.
