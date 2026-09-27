# 第 28 轮：重执行入口部署与真实验收

日期：2026-09-26。

## 部署与定向回归

- Web 正式重执行入口回归 135/135，通过日志 `docs/tmp/web-rerun-service-tests-round2.log`；真实 Web + Git 定向场景 1/1，日志 `docs/tmp/web-rerun-targeted-final.log`。
- UAT 交付证明相关回归 40/40，最终场景策略回归 31/31，日志分别为 `docs/tmp/sg15-platform-gates/full-related.log`、`scenario-policy.log`。
- 已安装包 SHA256：`C8550BD87F988A3DB643D7BF9D1E692F420B92DD7148DD67CA1370A9388AAE32`；81 个安装文件核对一致。
- 备份：`D:/dsh_home/backups/web-rerun-20260926-224745`；旧 PID 51924，新监听 PID 55040。
- 独立回读 health=ok、恢复问题 0、入站正常、认证 Web 200、73 个任务身份与状态不变；证据 `docs/tmp/web-rerun-deploy-20260926/readback.json`。
- 原话题引用链确认后端 UAT3、前端 UAT2，沿用 round-27 原始消息证据。未修改两项原 PR 或执行远程合并。

## 真实前端验收：FAIL

- 使用 PR368 开发分支提交 `b447f4826a353d6d82d7349fc7f571d9c831664c`，候选 `4e309314fe1cc14698d31f084d03eb38382a8d9f17ef4bd491fdaf5385dc7027`。
- 准备、后端启动和前端启动成功；业务步骤 42 秒后返回 `LOCAL_ACCEPTANCE_COMMAND_FAILED`。未证明草稿保存回显通过。
- 执行器未保存本次子命令错误细节，不能将失败归因于磁盘、产品或脚本中的任一项。后续须先补足脱敏阶段诊断再重跑。
- 清理收据：浏览器关闭、真实登录会话注销、共享业务写入 0、双服务停止；独立端口回读 59400/54668 均无监听。
- 证据：`docs/tmp/branch-reuse-deploy-20260926/review-receipt.json`；独立 ledger 位于运行目录 `shared-uat/readonly-evidence/acceptance-ae85cc55ca488ff35f6dac1e3a8a6941/review-ledger.json`。

## 后端验收：BLOCKED

- 仅零写入预检完成；专属 0.5kg/声明 t 用例写入适配器未实现。
- 共享库插入/更新会发送 `editor_tw_processes_table_changes`，尚未确认消费者及派生资源清理方式，已询问用户。审计日志应保留。
- 两条真实任务开发及 UAT 提测全链仍未通过，C33/C34 保持 NOT_RUN，SG15 未完成。
- C 盘空间不足曾导致测试失败；相关测试已改用 D 盘临时目录重跑通过。临时目录清理被自动审批策略拒绝，未重试删除。
