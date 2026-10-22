# 第9轮：主线融合、合并与本地部署

用户明确要求合并 PR #248 并部署本地，Claude 登录继续留待之后。本轮仍复用三个执行成员，分别负责部署前置只读核验、独立合并验收、部署后配置页面只读验收；具体职责与证据放在 round-9/ 各自执行文档。主检出未提交内容保持原样。

## 主线融合

fetch 后 origin/main 为 `3fd56f92212155f303cf3935748c9381c75ff632`，本分支原 head 为 `88e28f48f32e8f2f354b5b947d092025bfc3ed86`，共同基线为 `192e808`。唯一冲突位于 README：保留 main 的定时目录查询、来源时间两段，同时保留本支“DSH 推理深度”适用范围。服务代码自动融合，仅新增上游 `onRecovered: id => failures.delete(id)`；双后端、反馈、文档代码没有被覆盖。独立审阅确认无未解决条目。

- `round-9/merge-unit-1.log`：协调时间、变更、恢复、工具 schema、话题运行及套件合同，201 PASS、0 FAIL、0 SKIP。
- `round-9/merge-native-boundaries-1.log`：独立串行最小原生组，8 PASS、0 FAIL、0 SKIP，78.36 秒；包括上游告警恢复、混合团队后端固定和六项进度/文档/原身份续办。前后服务摘要相同，来源记录见同名 source.json。
- suite-map 正式 update/check：301 文件、历史 3、删除 0，无历史规则放宽。
- `round-9/merge-release-smoke-1.log`：真实现场宿主为 rc.2，完整打包 smoke 使用已安装 Web profile，14 PASS、0 FAIL、0 SKIP，52.000 秒；真实提取包运行及 resident 健康检查通过，不用旧 alpha profile 推断现场兼容性。

## 部署前基线与边界

只读核对本机 `D:/dsh_home/profiles/web`、任务库 `D:/baibu-agent/.dsh/task-sessions.sqlite`，3080/18998 原 PID 为 54892。宿主声明/安装均为 0.2.1-rc.2，原 Assistant/Observer 2.1.0 产物来自 main-192e808。健康原为 degraded、2 项恢复告警，但入站和 DWS Bridge 已就绪；这是既有基线。

首次只读 ledger 检查报 DEPLOY_NOT_DRAINED，原因是一项执行未排空；未发信号、未停止业务。后续该执行自然 succeeded/drained，原生回合已有 turn/end；正式安装前仍须重新完整 Check，不能用这一项结果代替全账核验。无 Claude 执行，无 starting/unknown 操作或通知的快照不代表之后状态不变。

按现有原生部署脚本传入精确双包和 profile 摘要，先 Check 零副作用，再原生退出、安装与新进程就绪。不得强停活动业务、初始化/清库、重放通知或登录 Claude。安装后核对默认 DSH、实际配置入口、版本/摘要及运行态；没有真实 CLI 历史样本不造样本。最终合并与部署事实另在本轮追加。

## 发现的同因运维缺口

既有 checker 对 CLI 的 sessionBound 记录误查 DSH 原生日志。`round-9/deploy-cli-checker-first.log` 保留旧实现读取不存在 `.dsh/sessions` 的真实首错。新增后端检查使用标准库独立运行，验证 CLI journal 的身份、输入历史、租约、严格序号、链接路径和最终排空；不清理 unknown、不恢复执行。实现及独立审阅继续核对连续未启动续办、取消、任务修订形成的 stale，基于真实 Store 确认同租约历史排空而非假造新轮完成。修复后验收在 R10，保留首错及中间版48项记录。
