# Round 16

2026-10-25. Final actual installed-host browser acceptance after the driver registered the real Codex Connect `稍后提醒` control as a Playwright locator handler. This only invokes the visible host action; it does not remove overlays, force clicks, change Host preferences or mutate resident state. Five variants passed: desktop light, mobile light, desktop dark preference, mobile dark preference and desktop forced-colors. Each passed 7 cases: first valid group/no unfiltered request, keyboard focus and type priority/progressive disclosure, task-service drill-through and return across groups, source focus restoration, real schedule state/next trigger/rule with empty task section absent, manual/5-second refresh selection retention and no horizontal overflow.

Desktop1440x1000 shows10 fully visible rows at67px; mobile390x844 shows8. All variants recorded console errors0, failed observer API0 and resident mutations0. The installed Host persisted light theme despite browser preference where applicable; no Host setting was changed. Source hash in every JSON is the frozen candidate web-client source.

Round12/13/15 remain separate failures: the real update notice intercepted ordinary clicks, and round15 also exposed a driver post-context error; neither was rewritten. Round14 proved ordinary dismissal and task-service HTTP200; round16 is the clean final result.

## Final Regression And Evidence Checks

Final local command:

```powershell
node --test test/coordination-observer.test.js test/observer-client.test.js test/observer-slot-compatibility.test.js test/observer-board-restoration.test.js test/observer-archive-interaction.test.js test/observer-node-control-display.test.js test/restart-web.test.js
node scripts/test-suites.mjs check
node --check packages/dingtalk-dsh-observer/web-client.js
git diff --check
```

101/101 PASS,0 fail/cancel/skip; suite map308 files exactly once,historical3/deleted0; syntax/diff PASS. This final scope is narrower than the earlier round11 136/136 run,not an additional claim of136 at round16. Independent lead check matched5 current-source hashes and20 PNG byte/hash pairs. Viewed actual masked mobile list and desktop dispatch without overlay; baseline round7 uses the same viewport/group/10 sources. Desktop5->10 and mobile4->8 visible rows; row111-153px->67px. Native light persisted for all preference variants; actual installed dark UNVERIFIED,source-isolated dark separately passed round11.

Regenerate with `python -I docs/acceptance/coordinator-work-visualization/scripts/refinement-browser-acceptance.py --output docs/acceptance/coordinator-work-visualization/round-N --theme light`,then `--mobile`,dark preference variants and `--forced-colors` in the same fresh round-N. Script refuses existing result files. Start from the already running verified native instance; do not reinstall/restart just to repeat browser reads. It obtains local authentication without printing credentials. Screenshots are local/gitignored and mask business content; only small JSON/hash metadata is tracked.

Driver follow-up: request/error listeners now use the explicit --api port rather than hardcoded native/web ports. Native round16 used18998 (unchanged); an actual extracted-AST check exercised18998 and isolated19088, observing POST and503 plus excluding a foreign port:2/2 PASS (driver-api-port-check.json). Synthetic round9-11 did not actually observe isolated19088 API errors/mutations with the earlier hardcoded filter; their UI assertions remain valid but those isolated zero-count fields are not proof of no traffic. No synthetic zero-write claim is used in place of native round16 proof. Temporary isolated host stopped; independent ports19087/19088 listeners0. Final independent native readback again matched PID45548,health ok,recovery0,inbound true,autostart and authenticatedWeb200.
