# Round 15

2026-10-25. Actual desktop light7 cases PASS; mobile light FAIL while clicking a cross-group source (driver line203). Raw console identifies the real unrelated Codex Connect notice: `data-shell-overlay=true` intercepts pointer events. The prior dismissal immediately before 查看任务 is too late on mobile because the overlay can cover the source row itself. No forced click,package/source edit,install or restart was performed.

A second driver defect then interrupted JSON reporting: except tried querying the browser after leaving sync_playwright,raising `Event loop is closed! Is Playwright already stopped?`. This is a FAIL,not an absent/passed run. Remove that invalid post-context browser query; keep sanitized original failure type/signals/line metadata. Remaining dark/forced variants were not executed in this failed batch. Screenshots already generated remain local.

Root-cause correction for the driver: register the ordinary 稍后提醒 button with Playwright's native add_locator_handler,so actionability checks can dismiss this recurring external Host notice wherever it appears. This neither removes DOM nor changes product preferences. A fresh round16 will verify all variants; round15 is retained.
