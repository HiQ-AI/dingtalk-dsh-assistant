# 本地性能优化整合

最终采用同一个 SQLite 内活动/归档分表，撤回未部署的任务目录详情分库方案。参见 [归档操作说明](../ops/task-archive.md) 与 [分页覆盖清单](observer-pagination-coverage.md)。

启动保留恢复快照复用和阶段计时，遵循 main #285：普通启动不执行 quick_check/foreign_key_check 全库审计；worker 仅用于显式维护。看板按薄索引选择本页 ID 后读取正文，文件证据按有界块读取。无变化维护巡查不新增永久命令回执。

原 11 成员、并发 2 的真实本地会话合成测试保留原 45 秒预算。旧外置草案曾显著回退；同库初次复测 44.44 秒通过，随后移除 taskState 刷新对 execution 正文的重复读取，最终串行 44.842 秒、1/1 通过，仍接近 45 秒且未证明整体场景提速。main644 独立对照 13.236 秒，不能将单次结果当作业务 SLA。

此前历史 test:all 运行 unit 848/848；native0 为 163/193，12 失败、18 取消，后续历史分组未执行。该失败记录保留，不宣称全仓全绿。按用户要求删除两项仅约束内部恢复步骤的夹具，调度规模夹具由 42 缩至 6，但保留跨组进展及重启不重放结果断言；11 成员场景已恢复。

最终核心验证覆盖持久化、归档事务回滚、未知副作用保留、回执重放、全局事件序号、分页读取边界与 SQL 索引计划。所有数据库和迁移验证均为合成数据，没有真实迁移或部署。

最终核心分组 324/325，唯一新增迁移夹具把 replayed 标志写反，修正后迁移文件 3/3；不宣称 325 全跑通过。归档基础与迁移 10/10，发布烟测 14/14、零跳过。原 11 成员串行测试 1/1，44.842 秒。日志在 scratch/integration-evidence/single-db-core-final.log、archive-old-flag-migration-final.log、single-db-eleven-serial.log、single-db-release.log。

## 同条件性能复核与最小去重

旧 main644 的 13.236 秒单次记录不能在当前环境重现。本轮同测试主体、同 native fixture profile、相同 Node、TEMP/TMP 和串行无本线程其他测试负载下，main644 为 46.982 秒，候选修正前 44.842 秒。测试主体与前 100 行 harness 均逐字相同，profile 文件相同；旧记录未保留足够环境状态，不能将其作为稳定 SLA 或证明本 PR 增加 31 秒。

只对原 11 成员做一次 5000 微秒 CPU 采样（elapsed 43.795 秒）：单个 checkedDirectory 调用树约 6.56 秒，realpathSync 下约 4.23 秒。task-archive.js 调用栈合计约 0.07 秒，observer-pagination.js 的 JS 栈约 0.01 秒；SQL 触发器时间可能计入 dynamic-task-store.js（约 3.51 秒），不能把 JS 采样等同 SQL 精确计时。采样为统计估计而非完整 IO 追踪。

确认同一同步 store 调用两次 filename/目录校验，且目录判断两次 lstat。仅复用该次调用的 path 和 stat 结果，不跨调用缓存、不减少后续读取校验。修正后 11 成员为 41.756 秒（1/1），仍保持并发 2、原 45 秒预算和原结果断言；单次波动不能证明稳定提速百分比。正文投影 18/18，原文件按需读取及重启路径回归结果见 model-context-dedup-native.log。未扩大为全历史套件。

证据：main644-eleven-current-serial.log、single-db-eleven-profile.log、single-db-cpu/*.cpuprofile、single-db-eleven-dedup.log、model-context-dedup.log，均位于 scratch/integration-evidence。
