# 第四轮：最终本地验证与交付边界

2026-09-07。实现工作区为独立 worktree-topic-driven-processing；主检出未改源码。

## 实跑结果

- `pnpm test` → 233 tests / 233 pass / 0 fail / 0 skipped；原始输出见 round-4/full-tests.log。Runtime + Topic 为 84 项，旧 70 条 Runtime 行为映射见 round-1/runtime-coverage.md。
- 原生 DSH + fake 模型：route 2、decision 2、checkpoint 3、result 1、内部 review 4、reply 1；持久读回 3 个 Topic 决策完成，一个 Task 完成，重复 Web requestId 仍只有一个 Task。第三轮生产源码未再变化，证据及源文件 SHA256 在 round-3/native-dsh.json。
- `node scripts/build-web-client.mjs` → exit 0，重复构建结果相同；web-client SHA256 为 E9DC34A1AFA897CECE3057E7ECCC6ACF3B45BEA49B65C29D6FFD11F492D0237C。
- 三个 `pnpm pack` → exit 0；README 补充执行归属说明后重新打包，独立目录读回 3 个 tgz，tar 内容检查含新增 Topic 模块。最终文件名、字节和哈希见 round-4/packages.json；没有发布 npm/Release。
- 隔离 JSON SDK 迁移覆盖只读检查零写、独立目标重开、重复迁移、旧 v6 回退可读、来源缺失和冲突拒绝、旧通知回执保留。输入为人工构造的 v6 形态，不冒充真实 profile 副本。
- Observer 独立 Edge 运行真实客户端代码，验证话题列表、分页、固定版本、Task 跳转、失败重试、加载及旧响应隔离、390px 内容区；宿主组件和 HTTP 为替身。证据见 round-1/observer-checks.md、round-2/peripherals.md。

## 反证、取舍与未验证项

- 引入 Topic 日志不等于整体延迟更低。160 个 Topic、40 次顺序采样的 JSON 后端实测：ingest P95 从 4.37ms 到 6.27ms，route P95 7.83ms，accept P95 6.95ms；介质约 152KB 到 342KB。固定版本分页上下文由 40KB 降为 12.6KB，但未测真实模型归类耗时、持续流量积压与容量 SLO。详见 round-1/store-performance.json。
- 持久意图、稳定动作身份和 Group 内队列提供恢复依据；SDK 不提供跨表事务。现有故障注入和重开通过，不等于在每个进程强杀点或断电点都实测成功。
- Topic 关联不是授权。明确给他人的任务及取消仍受原始消息检查；误归类不重复执行已消费事实，也不自动撤销已发生外部动作。
- 同群未归类输入暂时阻止旧决策提交；归类后无关 Topic 独立推进。同 Task 的版本与 reservation 仍串行约束，这是必要的共享资源边界。
- 真实模型的语义归类、真实 DWS 的引用/@/撤回/附件恢复及投递读回、真实 profile 的停机迁移、已安装 DSH Web 宿主集成都未执行。matrix.csv 保留这些部分覆盖/未执行项，因此不生成全绿 report.md。
- domain 7 为破坏性存储升级。必须按 docs/ops/topic-storage-migration.md 停写、保留原存储及匹配 Session、迁到独立目标后再切换。已有外部动作不能用恢复旧文件撤销，回退前需对账。

本轮交付是实现、隔离验证与 PR；没有部署、版本发布或向真实群发送测试消息。
