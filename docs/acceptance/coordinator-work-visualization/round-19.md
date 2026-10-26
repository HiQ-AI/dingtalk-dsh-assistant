# Round 19

2026-10-25. Fresh isolated real React/primitives/HTTP/SQLite browser matrix after round18. Mobile light, desktop dark and desktop forced-colors each passed the entity-specific browser contract: original failed-result API, first valid group without an all-group request, one visible primary result per entity, focus/selection, progressive disclosure, nine persisted reminder outcomes, explicit all-group selection, empty selected group, task return, manual/5-second refresh, no overflow, no console/API errors or mutations. Evidence summaries:

```json
[
  {
    "file": "after-desktop-dark.json",
    "result": "PASS",
    "cases": [
      "stable-entity-dedup-and-original-failure-api",
      "default-first-group-no-all-request",
      "failure-prominent-next-step-disclosure-and-focus",
      "nine-persisted-reminder-scenarios-rendered",
      "dispatch-task-return-manual-and-five-second-refresh",
      "explicit-all-selection-retained",
      "empty-selected-group-not-fallback-all",
      "no-overflow-console-api-errors-or-mutations"
    ],
    "errors": [],
    "mutations": [],
    "failedObserverApi": [],
    "visibleRows": 10
  },
  {
    "file": "after-desktop-light-forced.json",
    "result": "PASS",
    "cases": [
      "stable-entity-dedup-and-original-failure-api",
      "default-first-group-no-all-request",
      "failure-prominent-next-step-disclosure-and-focus",
      "nine-persisted-reminder-scenarios-rendered",
      "dispatch-task-return-manual-and-five-second-refresh",
      "explicit-all-selection-retained",
      "empty-selected-group-not-fallback-all",
      "no-overflow-console-api-errors-or-mutations"
    ],
    "errors": [],
    "mutations": [],
    "failedObserverApi": [],
    "visibleRows": 10
  },
  {
    "file": "after-mobile-light.json",
    "result": "PASS",
    "cases": [
      "stable-entity-dedup-and-original-failure-api",
      "default-first-group-no-all-request",
      "failure-prominent-next-step-disclosure-and-focus",
      "nine-persisted-reminder-scenarios-rendered",
      "dispatch-task-return-manual-and-five-second-refresh",
      "explicit-all-selection-retained",
      "empty-selected-group-not-fallback-all",
      "no-overflow-console-api-errors-or-mutations"
    ],
    "errors": [],
    "mutations": [],
    "failedObserverApi": [],
    "visibleRows": 7
  }
]
```

The screenshots are local acceptance evidence; production 3080 was not modified by this isolated matrix.

Lead personally inspected desktop failure screenshot (round18) and 390px failure screenshot (round19): primary failure text and plan/no next-trigger/no retry are fully readable, no horizontal clipping. Installed-host masking proof remains separate.
