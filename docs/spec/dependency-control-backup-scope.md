# 必要依赖索引迁移的控制库恢复范围

本方案源自 docs/tmp/dependency-control-backup/plan.md 的停机部署前分析；仅覆盖部署脚本，不改变 Assistant 业务状态机。

schema 8→9 只更新控制库索引和版本。恢复边界应是 control.sqlite 原生一致性副本及固定 profile 文件；domain、Task 工作区、历史构建和工件不被该迁移修改，无需复制或遍历。普通无迁移部署继续无历史备份。Bootstrap、其他旧迁移和任务文件迁移保留既有完整范围。

原部署 helper 在 Readback/Resume 前无条件调用 task-directory-check，造成每次恢复重复全树容量扫描。该扫描仅服务新建完整历史备份；Readback/Resume 仍校验包、profile、输入 SHA、真实 PID、维护许可、Task/历史控制快照，以及绑定恢复范围内的证据。

控制库专用备份须以原生 SQLite backup 创建一致性副本，独立只读打开，校验 integrity_check、foreign_key_check 和全部表行数/摘要。源库备份前后逻辑摘要必须一致。调用仍处于停机 owner 独占锁及 sealed/drained 许可中。

manifest 明确 scope=required-dependency-control-only；backup/launch 收据绑定 scope 和 manifest SHA。修复启动只继承已核验的该范围及原已完成迁移收据；未完成迁移不能冒充安装失败续接。不增加任意范围开关，不对旧完整清单降级。

RepositoryPatches 使用原生配置器既有参数，提案纳入部署输入 SHA；与查询配置和离线修复互斥，工程 Bundle/MergePolicy/ChecksProposal 要求不变。expected-sha256 提供允许更新与 CAS，无新增 allow-update 参数。
