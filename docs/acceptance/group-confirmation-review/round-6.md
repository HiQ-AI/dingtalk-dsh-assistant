# 第 6 轮失败单例复验

使用已补强的 `verification_run.py` 即时保存 argv、候选前后摘要、原始 stdout/stderr 和退出码：

```powershell
python -X utf8 D:/dsh_home/skills/business-development/scripts/verification_run.py --cwd D:/codex/worktrees/task-resource-lease/dingtalk-dsh-assistant --evidence-dir D:/codex/worktrees/task-resource-lease/dingtalk-dsh-assistant/docs/acceptance/group-confirmation-review --name round-6-empty-recovery -- node --test --test-name-pattern 'empty owner recovery reviews' test/task-session-service-native.test.js
```

结果仍为 FAIL，退出 1、candidateUnchanged=true、validCommandEvidence=false。15 秒内部等待再次超时，快照仍是三项执行成功而统筹收口中；没有更改或放宽断言。证据为 `round-6-empty-recovery.json` 及同名前缀原始日志。后续仅对该例做基线比较和时间线核查，不据重复超时猜测为生产回归或直接增加超时。
