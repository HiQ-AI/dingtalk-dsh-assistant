# 第八轮：正式部署首次尝试

结果：FAIL，未恢复派发。新包安装字节核对97文件通过，完整备份完成，但新Host启动时出现 `WORKFLOW_VERSION_UNAVAILABLE` 并退出，无3080/18998监听。

部署对象为PR #141提交7d064d4的Assistant 0.5.15构建包，598423字节，SHA256 `3b5ce6eb99fbec773f9137bd21ce4ec28718a9dfb1a417dcdd619cf519aba58e`。配置原样应用 changed=false/writes=0；cordis.patch.yml SHA256 `5d3e9c333eb33f9a38971e1485f2858ede87e810f7ece49def12c88701fc933f` 未变。

已通过维护排空与封存停机许可、独占owner锁、完整Domain/Runtime/Profile备份及一致SQLite验证。备份为 `D:/dsh_home/backups/owner-repair-20260929-111951-779`。原始证据在本工作树 `docs/tmp/workflow-domain-deploy-7d064d4/controlled/`，包含真实任务和认证相关日志，禁止提交公开仓库。

根因：Owner恢复引用扫描只排除完成态，误将已取消的退役调查v4纳入必须恢复定义集合。修前真实SQLite/Controller取消反例复现相同错误，活动与暂停反例保持严格阻断，见 `round-8/retired-owner-control-red.log`。修复精准排除 cancelled，无摘要改写、数据迁移或旧效果重放。

C盘TEMP空间不足造成一次测试环境失败，单独保留 `round-8/retired-owner-control-environment-failure.log`；使用D盘进程TEMP重跑，不清理用户文件。此环境错误不是产品修复通过证据。

当前保持维护封存、排空和停机，备份保留。修复安装、正式健康和真实模型验收尚待第九轮验证，不能声称部署成功。