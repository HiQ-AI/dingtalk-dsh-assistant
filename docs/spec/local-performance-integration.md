# 本地运行时三项性能优化集成约定

## 范围与固定基线

- 基线 `041277a23d443e527e67ca44272144edd2e42c38`（#284），分支 `codex/performance-local-runtime`。
- 原分页worktree与含P2补丁保留。新集成worktree只处理代码、合成测试和PR，不改线上profile、ACL、全局safe.directory或真实任务数据；不合并/部署/真实迁移。
- 最终一个draft PR同时交付启动、分页、任务详情目录存储；不能把分页单项当三项完成。不自行触发CI。
- 当前新增会话 `sessionController unavailable` 由启动实现者单独诊断；本文件不归因插件、不重复采集现场。

## 当前接入状态

分页与基线已3-way整合。`dynamic-task-store`唯一源码冲突已同时保留`resourceCatalog`和`paginationMigrate`；生成测试清单基于main重建321文件、历史3/删除0。独立冻结依赖安装完成，仓库隔离native profile解析37模块，不加载用户凭据。首组181/181通过。固定main的完整分页适用回归862/862、0跳过已终态，日志pagination-main-full.log；这是分页阶段，不能替代随后三项整合验证。

启动定稿210e55d5118794f8af4a6202c19d449374b0740f已接入，保留resourceCatalog/paginationMigrate/startupObserver；存储定稿尚未接入；实现者在各自固定基线worktree工作，不能复制中途文件。待收到明确提交/补丁、测试与容量证据后按语义整合共享文件，不用整文件覆盖消除冲突。

## 分页与存储的接口要求

1. `observer.page`/`observer.work-metadata`、任务状态/topic/human/execution窄索引仍需可查询的轻量字段。任务详情外置后，不得让SQL `json_extract`或索引trigger把文件引用当完整task body。状态、版本、时间、关联ID、有限标题/摘要可保留全局；对话、prompt/result、长错误、完整请求/回执应在任务目录。
2. 列表先在存储层选页ID，再投影/读取本页需要的详情。任务列、执行摘要尽量只用轻量元数据；授权详情按本页request ID读取，不能为一条授权解码整任务历史或在file payload内切全数组充当分页。已有计数/排序/过滤/版本变化语义保留。
3. 旧数据兼容、文件摘要/路径归属、原子可见性、失败回滚由存储实现提供既有语义；集成者验证SQL页、详情、CAS/恢复均一致，不直接重写在线库。离线维护默认只检查，不在打开既有库或GET时自动迁移。
4. 启动实现保留新库/现有库和owner/资源目录语义，以及分页索引显式迁移边界。优先消除重复扫描和启动阻塞；不为性能额外增加用户流程、开关矩阵或门槛。

## 合成分页基准

`node --expose-gc scripts/benchmark-observer-pages.mjs --base 041277a23d443e527e67ca44272144edd2e42c38`

固定Git blob的原HTTP handler与当前handler；独立localhost内存fixture；1个冷样本和5个热样本，串行请求，消息正文约1030B。分页同时计入群summary与10条消息两次请求；旧handler一次返回整群。没有读真实库/服务、没有真实模型或业务资源。

| 消息数 | 旧响应bytes | 分页响应bytes（含summary） | 返回正文数 | 热P50 ms：旧/新 |
|---|---|---|---|---|
| 1000 | 1698951 | 17148 | 1000 → 10 | 24.3 / 19.461 |
| 10000 | 17007952 | 17169 | 10000 → 10 | 266.848 / 19.994 |

数据来自 `scratch/integration-evidence/observer-benchmark.json`，含源码hash/Node版本/每个样本。此时后台有合成回归，时延只是观测，不是门槛或生产P95。消息已常驻内存；text getter访问不等于磁盘读取。空topic/outbox/source/notification，只验证消息API路径。基线handler的相对依赖用当前兼容helper，空辅助集合避免把其他领域改动当提速。P95仅5个热样本最大值。

冷分页仍会触及N个常驻消息字段并构建元数据；热页触及10条，上下文选择10个ID。不能把全局冷索引或页内关联历史说成O(limit)。最终三项整合后再在同样数据/命令复测，原始体积和正确性证据比微秒排名重要。

## 最终验证入口与证据规则

- `node scripts/test-suites.mjs check`：全部测试文件一次映射，未审查覆盖保守保留。
- 分页完整适用集合：`scratch/integration-evidence/pagination-main-full.log`；固定main的新鲜实跑，不拼接旧679/680和局部结果。
- 最终三项整合后按适用风险执行完整映射/相关历史与 `pnpm test:release-smoke`；使用仓库隔离native profile、Node24.19/所需Node22与JDK11、已有物理短TEMP。不能执行含全局ACL修改的CI准备脚本，不改断言预算。
- 三项各自功能/失败路径、合成性能与存储占用数据都需证据；新session问题未确诊前不作根因宣称。
- 最终代码冻结后独立审查，修复确定问题、实跑所需复验；按write-pr规则核PR正文、push前PR状态、创建后读回并附加PR。仅draft，不merge/deploy。

## Integration checkpoint (2026-10-28 UTC)

- Initial base remains `041277a23d443e527e67ca44272144edd2e42c38`; fetched main `644ff90c694e19f661177ffd7b5e595d452a9fae` includes merged PR #272. Incorporate it once after storage delivery; preserve first completion time, idempotent completion, source projections and ingress timing.
- Startup plus pagination regression: 193/193 passed, zero skipped (`startup-pagination-integration.log`). This is additional integration coverage, not the final three-module run.
- Historical sessionController failure is not reproduced and its root cause remains unknown. At 08:23:54 UTC enabled inventory and related services were active; `session/canOpenWorkspacePath` returned HTTP 200 / ok true. No screenshot-specific code or retry gate was added. Startup improvements do not establish a fix for that historical error.
- `node-output-readout.js` remains a repository helper for unpublished historical execution modules. It is excluded from the published runtime allowlist because its legacy-only dependencies are not published. Existing extracted-package tests inspect every shipped relative import.
- First release smoke attempt could not create fixtures under `C:/dsh-release-tests` (EPERM). No ACL changes were made; retry uses the authorized system temporary directory. Preserve both logs and distinguish environment failures from completed verification.

- Release smoke retry under the authorized elevated execution context completed: 14/14 passed, zero skipped (`startup-pagination-release-smoke-elevated.log`). It covered actual packed bytes/import closure, native task flow, and extracted resident health. No global Git/ACL settings changed. This is startup + pagination only; storage/latest-main final verification remains pending.
