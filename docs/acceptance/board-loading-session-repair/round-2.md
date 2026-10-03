# 第二轮实跑

补充根因：95条原生通知逐条读取notificationReplacements，继续占用同一worker队列。改为每页200条通知ID一次原生JSON查询，按restoresNotificationId归属，原单条查询供既有受管操作使用。真实SQLite回归覆盖批量归属、无关ID、201条拒绝；2项通过。相关服务16项通过，前端共享刷新及详情慢请求/切换旧响应24项通过。

## 正式部署

两次均按docs/ops/resident-review-local-deployment.md及既有deploy-owner-repair.ps1完成Check、排空、完整备份、安装、Readback及Resume。最终PID40044，ready=true，dispatchResumed=true，maintenance.active=false，Task数1。备份D:/dsh_home/backups/owner-repair-20261002-081811-611。Assistant3bb4b36cea1e57aa7045c79f664e97ba0b3f7255944e45028242f365e0bbe918，100文件；Observercd0677cd5e7ca94202350efde638d7a6945a2b731076708f6efc785a0a6bb014，4文件。profile e026ce9c9f7447968a6a2c8c7b13486d96134031e1b6d07f6f96e877e6f87e6f保持，配置writes=0。

## 页面与接口

独立headless MS Edge，经当前启动日志认证URL打开正式3080页面。关闭第三方更新浮层，打开运行看板→任务看板→真实任务卡片→当前任务详情→返回看板→群消息→打开群常驻会话。

无测试浏览器后台轮询时，三次/state/groups为1512/2248/1906ms（此前28068ms）；同一任务详情2712/2540/2083ms（此前3660/6053/5164ms）。每次200，群数据3367252bytes（与原3367054bytes相比仅增加当前绑定，不截断历史），详情6640bytes。独立页面首屏2956ms，点击真实任务卡片到详情4519ms，详情请求4127ms；此时仍有正常5秒看板刷新，因此页面没有宣称2秒或瞬时完成。失败测试浏览器原先残留轮询影响压测，已按精确PID树关闭，仅清理本次独立测试进程；最终脚本finally关闭浏览器。

原生列表两群均cwd=D:/baibu-agent，title分别广场与编辑器迭代、DSH端到端测试-20260927，permissions=danger-full-access；点击当前绑定后会话页标题广场与编辑器迭代、输入区完全权限，截图人工核对。当前绑定与旧历史父会话区分，原历史保留，不改写历史会话。当前任务详情显示调查两步骤完成，以及Owner原生状态冲突摘要，没有将DDL宣称完成。

复核配方：用PowerShell Stopwatch连续读取http://127.0.0.1:18998/state/groups及/state/tasks/task-e7e25daf5c0aac2f8bcb5ef13daef45f/detail；浏览器以实际启动认证URL打开上述路径，记录request/requestfinished及可见详情时间，再按/api/session/list的result.value.items核验当前coordinator绑定。认证URL、完整业务正文、原始截图保存在本轮docs/tmp/board-loading-deployment-round2-20261002，不入库；截图不是接口证据的替代。

通知去重39项及真实群撤回/历史回读证据见round-1.md；第二轮没有补发开始通知。UI严格审计0错误0警告。没有执行生产DDL；调查成功与Owner的TASK_OWNER_BLOCK_CONFLICT分别报告。
