# 最后一次单任务恢复与暂停

用户限定仅再试一次，不能跑通则提交代码并停止。

统一脚本 `pwsh -NoProfile -File scripts/deploy-local.ps1 -ArgumentsFile docs/tmp/single-task-fixed-deploy-arguments.json -Resume` 实跑退出0，dispatchResumed=true。维护暂停回补的健康判定已修正；脚本仍要求恢复后真实健康、收信和回补通过，原生脚本全文件通过，新正负例8/8。

实际任务复查仍 waiting，prepare-local-acceptance 为 LOCAL_ACCEPTANCE_PLAN_INVALID；plan-local-acceptance 原session、lease1未继续。流程未跑通，不再修复或重试。基线七个成功节点的nodeRunId/generation/leaseEpoch/outputRef/evidenceRefs独立比较7/7一致，没有重跑构建。

通过正式pause API暂停唯一目标；独立只读control.sqlite的task_controls确认SG18、SG19、SG20、SG22全部state=paused、control_revision=3，SG21原完成保持。

当前代码包含原执行会话定点恢复、禁止Owner工程修复和动态节点修订、真实检查回执恢复、批量Git搜索、正式暂停入口及部署流程修正。定向测试证据见round-82/83/84；尚未证明真实业务全流程完成，不写全绿report。全量pnpm test未运行，旧Owner动态修复正例仍待迁移。

现场证据保留docs/tmp/single-task-last-attempt-detail.json、single-task-last-attempt-pause.json、single-task-before-native-resume.json与maintenance-resume-core-test.log，临时运行数据不提交。
