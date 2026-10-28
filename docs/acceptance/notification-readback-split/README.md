# Notification send/readback scheduling and task-session prompt cleanup

Base: main 56483462ca81943ecd23cb6144644d8946acf897
Branch: worktree-notification-readback-split
Origin: https://github.com/HiQ-AI/dingtalk-dsh-assistant.git

The existing notification scan keeps sends serial until the send ACK is persisted. It then returns to the existing scan for confirmation: one send lane and one readback lane, with per-notification single-flight protection in each phase. Durable starting/unknown state permits only readback between phases. Existing unknown/starting records enter readback without occupying the send lane. Only send-phase transport errors set the shared send backoff; readback diagnostics retain their own retry schedule. ACK alone never marks delivery confirmed. No durable state/schema or completion transaction changes.

The task-session Topic adapter disables retired workflow instructions. Other Topic callers retain workflow guidance by default. Route/decision separation and Owner behavior are unchanged.

Validation: Node 24.19.0, pnpm install --frozen-lockfile. Seven relevant test files: task-notification-delivery, task-notification-readback, task-operator-notification-scan, notification-recovery-tool, notification-pending-source, task-completion-notification, topic-runtime (all under test/, .test.js). Final run: 248 tests, 241 passed, 0 failed, 7 skipped; see tests.log. New synthetic fixtures cover blocked readback across groups, prepared/unknown/starting, one readback per notification, send serialization before ACK, ACK not delivery, and both workflow modes. Existing durable-store tests cover recovery, failed sends and completion notification preparation.

Skipped: three pending-source native-profile cases and four native notification-scan cases (including native rate limiting). The isolated worktree lacks @deepseek-ai/dsh-base resident profile; no native profile was installed or recovered. No live DingTalk send, real task database, online DSH service, deployment, push, PR or merge was performed. Earlier missing-dependency and incomplete-fixture runs failed before the final passing run. This is code/fixture evidence, not deployed business acceptance.
