# Round 17

2026-10-25. Entity contract PASS; intermediate isolated real SQLite HTTP API FAIL: a known-not-sent reminder failure followed by schedule cancellation displayed `dispatched` instead of `delivery_failed`. The running module predated the notification-authority correction. Cancelled delivered/unknown retained their outcomes. Production state was not changed. See `round-17/intermediate-api.json`. Fix-rerun uses a new runtime and round18; do not overwrite this attempt.

Driver precheck initially used a nonexistent esbuild entry under the existing dependency root. The existing manifest records its real cache entry; the corrected explicit module path passed zero-write Check. Browser/production deployment not attempted in this round.
