# 第42轮：框架部署与真实UAT重验

用户授权合并、部署、重跑真实 UAT。PR #126 已合并为 `c573adc6e8905f56a3ccb3cb94ec63d4d1343ad2`，本地 main 独立回读一致。权威 goal 继续位于当前 worktree，后续部署修订使用 worktree-framework-uat-recheck 分支。

部署前发现已有脚本写死上轮 worktree，改为从脚本位置解析仓库，保持包/源码/安装内容和证据目录门禁。首次新增测试误用自动变量作为参数，测试未进入部署；已修正夹具，16 项断言通过。

部署包 SHA256 为 `5d3fa2fbb84e029d4c57f7cacf620e6155dd55908639b083c6820246aac9b8fa`，源码、包、安装目录 85 个文件一致；新 runtime PID 6012，Web 认证回读通过，历史 16 个 native tasks、76 个旧 nodes、21 个终态 runs、68 个 legacy tasks 保留。证据在 `docs/tmp/round42-deploy/`。钉钉入站仍因既有认证问题降级，不作为本轮业务通过证据。

## FAIL：恢复派发后的 Owner 回归

恢复派发后，阶段事件身份变化使已完成任务被重复唤醒。两条最近业务任务的 Owner 退回等待，业务任务及阶段仍成功。已立即进入 `round42-owner-regression` 维护，revision 28，所有 busy 计数为零且 drained。尚未重跑 UAT。后续修复和重验另记第43轮，不覆盖本轮失败。

用户确认本次在现有 dataset UAT3、dataset-web UAT2 上重跑真实业务验收。已合并修复无需重新提交；现有 rerun 会重走工程提交，不能用作交付后重验。本轮不触发新的构建部署流水线。
