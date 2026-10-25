# Coordinator Work Visualization Report

## Delivery

PR #258 is MERGED: https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/258

- Merge: `22d57386ebb5a11b89ab30e461a0b95e7bfc7f53`, mergedAt `2026-10-25T03:35:04Z` (independent gh readback).
- Subsequently authorized local deployment and real installed 3080 host read-only acceptance completed; see round-4/5/6 for preserved failures and final proof.
- Original deployment script exited1 at the five-minute startup wait. Same new PID91732 became ready without reinstall/restart; original failure retained, independent final package/process/health readback PASS. A new source-only follow-up fixes the bounded wait to600s, with11 regression PASS.
- Actual real-host default-light desktop/mobile each pass11 cases;18 existing sources,2 dependency members,3 proof members. Console/API/mutation requests0. Actual installed dark remains unverified because persisted Host light overrides browser preference; no Host settings changed.

- Base: `main`
- Head: `worktree-coordinator-work-visualization`
- Implementation commit: `6c495d09a3c30381f29558a0068bb1ef88d2d910`
- Remote state read independently with `gh pr view`: `MERGED`; merge SHA/time match the intended delivery.
- Local dual-package deployment performed under subsequent user authorization. No operator business write, real DingTalk test send, notification replay, CI dispatch, main push or force-push.

## What changed

The existing observer now has a read-only **协调工作** page backed by the real resident service and dynamic SQLite store:

- A bounded source list and source detail API at `/state/coordination-sources`, with group filtering, server pagination, explicit 400/404/503 behavior and safe diagnostic fields.
- A field-by-field projection that preserves reserved, rejected, clarification and unattached inputs; reuses `coordinationSnapshot`; keeps accepted/applied, formally fulfilled, action success and notification delivery distinct; and reports detail collection truncation.
- An observer page using existing host primitives and navigation, with task/dependency reading, saved decisions and limitations, waiting/blocking reasons, schedules, occurrences, delivery state and version-bound proof references.
- Independent 5-second list/detail reads with abort and scope identity guards, stale-data retention on same-scope failure, explicit retry, keyboard focus restoration and plain-text business content.
- A narrow-screen header fix based on a real 390px overflow finding: the grid can shrink, the status cluster wraps, and the refresh control is not clipped. Existing navigation remains locally scrollable.
- API/design/runbook documentation, package whitelist closure, focused regression coverage and an isolated Chrome/React/primitives/HTTP/SQLite acceptance harness.

Key implementation locations:

- `packages/dingtalk-dsh-assistant/coordination-observer.js:18`
- `packages/dingtalk-dsh-assistant/http.js:264`
- `packages/dingtalk-dsh-assistant/task-session-service.js:85`
- `packages/dingtalk-dsh-observer/web-client.js:532`
- `packages/dingtalk-dsh-observer/web-client.js:1792`

## Verification

The acceptance matrix in `docs/acceptance/coordinator-work-visualization/matrix.csv` is green for round-3.

- Relevant regression command: 167 PASS, 0 FAIL, 0 cancelled, 0 skipped.
- `node --check packages/dingtalk-dsh-observer/web-client.js`: PASS.
- `node scripts/test-suites.mjs check`: 308 files verified, each exactly once; historical 3; deleted 0.
- Assistant `npm pack --dry-run --json`: 70 files and `coordination-observer.js` present; no package published.
- Observer `npm pack --dry-run --json`: 4 files and final `web-client.js` present; no package published.
- Strict frontend audit: findings/errors/warnings/violations/unresolved all zero.
- Round-3 seeded Chrome: desktop light 13 cases; desktop dark, mobile light and mobile dark 12 cases each; all PASS.
- Round-3 independent empty SQLite: desktop light and mobile dark 2 cases each; both PASS.
- The browser harness loaded actual React 18.3.1 and more than 100 native primitive exports. It used real production HTTP, SQLite and task-service read DTOs. It verified real task detail drill-through and return to the selected coordination source, a production command changing SQLite followed by observed 5-second polling, delayed-response isolation, network failure/recovery, formal proof and dependency waiting, keyboard focus and 390px no horizontal overflow.
- Lead independently verified 36 source hash/byte pairs and 10 PNG hash/byte pairs (1,009,890 bytes). Final screenshots were directly inspected in light/dark desktop and mobile variants and an independent empty state.
- The earlier 390px observer overflow (`scrollWidth=394`, `clientWidth=390`) remains documented as round-2 FAIL; round-3 passes after the header fix. Evidence was not overwritten.
- The acceptance scripts reject output outside the formal acceptance root and reject non-`round-N` directories with exit code 2. Host `--check` passed without creating runtime data or listeners. Formal evidence is under the worktree `docs/acceptance/coordinator-work-visualization/`; jobs/tmp contains only runtime staging/dependencies.

## Boundaries

The round-3 browser harness is a deliberately minimal ModuleLoader/slots/session adapter, not complete installed-host proof. Subsequent round-6 separately verified the actual installed host:

- Assistant2.1.0 SHA256 `77eea78e705ee62085afc31baab956ce2f61d2f0dc8ad09dba98c2280c0fa2a9`, Observer2.1.0 SHA256 `b5a468c15c4c11c757a3275887a72e8c65a2bdf438f2266f2d64514ec9f135cd`.
- New91732/parent93000 owns3080/18998; old84680 absent; profileSHA74fe100c unchanged, Host0.2.1-rc.2 unchanged, autostart enabled/running.
- health=ok,recovery0,inbound true,bridge healthy,listeners ready/backfills ok; authenticatedWeb200. Retired maintenanceGET404 is expected; native disposal/autostart restoration, not a legacy Resume.
- Not performed: real model inference, real DingTalk test send, operator notification reconciliation/replay, business mutation, actual installed dark-theme switch, production fault/empty-state injection or CI dispatch.

Business input, requirements, summaries and evidence may contain sensitive local content. The projection is a local privileged observer view, not a public redacted export. It excludes actor/recipient IDs, prompts, commands, raw proposals, paths and raw diagnostics. GET operations are read-only and do not retry commands, notifications or business processing.

Round-3 isolated and round-4/5/6 actual-host results retain separate provenance. PNGs are local/gitignored; JSON/hash metadata/scripts/round summaries tracked. Final actual screenshots: `round-6/native-desktop-light-detail.png` and `round-6/native-mobile-light-detail.png`, masked business text and no Host sidebar. PR258 merged and local dual-package deployment verified; startup-wait source fix and evidence use a NEW follow-up branch/PR, never push the merged implementation branch.

## Follow-up Delivery

Startup readiness wait300->600s and final deployment evidence are delivered in PR #259 (OPEN): https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/259. Independent gh readback matched main/base,worktree-coordinator-work-deployment/head,implementation commit5ccfd218ed84711af21850526ed5586a4110b364 and complete checked local PR body. Local regression rerun11/11 PASS; no follow-up merge/redeploy or CI dispatch. PR258 remains MERGED and its implementation branch was not pushed. Final bookkeeping is a docs-only closure on PR259.
