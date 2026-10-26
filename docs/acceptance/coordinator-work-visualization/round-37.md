# Round 37

2026-10-26. Actual installed Host, PID93604, ports3080/18998; frozen product source403d9597/UI491123de/service6d792c0f. No deployment repeated.

## Functional Assertions

Desktop1440 light, mobile390 light, mobile390 dark preference and desktop forced-colors each returned7 automated cases PASS. Existing two prerequisite relations were dispatched/accepted, and linked target pages showed the same relation state. Original failed reminder remained primary delivery failure, with no invented retry. Filters, task return, focus, manual/five-second refresh, overflow and console/API/mutation checks passed. Raw JSON is retained as the functional assertion result, not an overall visual certification.

## Visual Acceptance FAIL

Personal inspection of `round-37/after-mobile-light-native-relation-1.png` found a late Host update notice covering the relation and result. Therefore relation-native visual acceptance is FAIL despite automated functional PASS. Earlier desktop relation screenshot was unobstructed. No screenshot or JSON was overwritten.

Root cause: Playwright locator handlers run during actions/assertions, but a direct element screenshot does not invoke the existing normal-dismiss handler. The shared driver now checks for the visible notice, clicks its ordinary `稍后提醒` button and asserts it is absent immediately before each screenshot. No force-click, CSS hiding, Host setting change or product edit. New evidence must use round38.

Native dark preference still observes persisted light; native waiting/failed-dispatch samples are absent. Do not invent production fixtures or count these as tested.
