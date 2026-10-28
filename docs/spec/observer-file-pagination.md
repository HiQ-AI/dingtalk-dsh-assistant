# 输出与证据真分页：读取边界和离线迁移

2026-10-28。本说明仅对应独立 worktree 本地实现和合成验证；未修改安装版本、在线库或真实业务文件。

## 读取契约

| 入口 | 修改前 | 修改后 |
|---|---|---|
| workflow messageEvidence：已记录 material、snapshot/history/quote、共享 IB source | messages.state 读全消息相关记录；可能聚合全 trace；取完整 material.text 后 slice | 只读 runId/conversationId header、精确授权绑定、text meta；按 hash 和 UTF-16 offset 读取最多 4 个 4096-unit SQL 块（最多 16384 UTF-16 units），再截取请求的 2..8000 units |
| workflow messageEvidence：本消息答复 artifact / query evidence | 完整 readFile+SHA+JSON parse 后生成正文，再 slice | 可信 execution ledger 根 → 最多 8192B header → 至多 3 个 8192B UTF16LE 数据块，以及每块最多 ceil(log2(ceil(totalLength/4096))) 个 32B Merkle sibling；不读取原 JSON 正文 |
| workflow taskNodeOutput：output | 完整 artifact read 后格式化整段，再 slice | 保留 family/latestTask、task/run/node、ref、detailRevision 和读后 revision 检查，再走同样的随机文件页；页内正文不调用 artifacts.read |
| workflow taskNodeOutput：document 下载 | 返回完整 Markdown 文档 | 保留完整下载语义和原格式化/历史 context 恢复，属于非分页下载；不会谎称此路由只读一页 |

所有 evidence 的 offset/hash、UTF-16 surrogate 边界、整段 executionDigest(text) 和 totalBytes 语义保留。SQL 使用 start 的上下界，深 offset 不从第一个文本块遍历。群组权限先检查精确 header；artifact 对本 run 的 output/query 关系从狭窄 bindings 表读取；共享 IB 的 source 只投影到其 input.units 声明的 run，不能据 resourceRef 跨消息读取。

`observer-evidence-pages.js` 在消息 material/node/agent-execution 与 run snapshot 写入时维护文本 meta/chunks/bindings，删除时移除对应授权索引。旧数据仅在显式离线 schema 迁移回填，GET 不建表、不回填、不写缓存文件。原 snapshot/record 的存储不变，因此文本块是额外派生副本，当前未跨 run 去重或压缩。

## 文件完整性与写入范围

原 SHA256 artifact 引用格式不变。节点展示格式函数提取到 `node-output-readout.js`，原 workflow-service 导出保留。新索引只在输出发布或显式离线回填生成：消息答复由 message-agent 明确标记、query evidence 按 kind、节点输出按 nodeId；普通 inputs/receipts 不创建任何 sidecar。文档下载不生成额外 document:view 文件。

每个必要 view 使用三个附属文件：固定 UTF16LE 正文、二叉 Merkle tree、最多 8192B manifest。manifest 的 SHA256 根由 execution store 的 `observer_artifact_page_bindings(ref,view,root)` 持久保存。GET 首先取得该可信根，拒绝 manifest 不匹配；页块与 Merkle proof 绑定 manifest 中的根。text/hash/meta 三个附属文件即使一起被改，hash=null 的首页也不能自证为真。该信任边界与已有业务授权一样信任 execution ledger；不会用同目录的独立自证 sidecar 数据库替代。

新 artifact 写入前后的完整 JSON 校验仍按原内容地址执行；离线回填也先验证原 artifact SHA。分页 GET 使用原文件的 size/mtime/ctime 身份条件和可信投影证明，避免每页重读整个原 JSON；会拒绝可观察到的原文件身份变化。它不是每次 GET 再验证原文件全部字节。原文件被改变但系统身份也被特权操作伪造的场景，不等同于对原文件逐字节重新校验；可信投影仍绑定最初验证内容，无法用改 sidecar 伪造新正文。

发布阶段遇 EEXIST 必须字节一致，否则 INDEX_CONFLICT；不能悄悄复用不同的旧 sidecar。复制 artifact/索引时 ctime 等身份可变化，即使正文相同也需要下面的显式 --rebuild。单独打开 openExecutionArtifacts 而未注入 persistent bindings 时，仅持有进程内根；重新打开后缺根会明确要求迁移。生产 openExecutionRuntime 已注入可信 execution store，重启读取不重建绑定。

## 旧数据与 context 兼容

缺文本表、缺可信根或缺 view：`OBSERVER_TEXT_MIGRATION_REQUIRED`，HTTP 503；不会退回全读后切片。已存在 trace_index 但缺 evidence/topic/binding 表的中间未发布 schema，不误报 ready：只读检查 false，apply 明确 `OBSERVER_PAGINATION_PARTIAL_SCHEMA_REQUIRES_REBUILD`，无隐式删表修复。需从该未发布中间版本之前的一致性备份重建离线副本再迁移，不能在在线库猜测补表。

旧 prepare-workspace 缺 output.workspace、prepare-generation 缺 output.startingPoint 时，原 GET 曾从 effect/workflow 恢复 context。新发布若没有等效 context，不生成伪造/缺事实的展示 view；GET 明确要求迁移。显式回填必须在 reviewed manifest 中提供原来的 context.workspace/context.startingPoint，否则 `OBSERVER_TEXT_CONTEXT_REQUIRED`。测试对比原 describeTaskNodeOutput(node,value,context) 的完全相同正文。完整 document 下载仍沿用原 context 恢复路径。

`migrate-observer-artifact-pages.mjs` 要求离线 database、artifact-directory、reviewed manifest；默认只读检查。apply 要求单独一致性数据库备份与源/备份精确 SHA、无非空 WAL、无 active owner、owner sidecar/数据库排他锁。manifest 的每项包含 ref，可选 nodeId/context/messageOutput；query evidence 可指定 view=message-query-evidence。--rebuild 只在上述离线门槛内重新生成派生文件并更新可信根，原 artifact 和备份不变。未对真实库运行。

文件回填不是跨文件原子事务：失败会回滚可信 DB binding，但前面创建的派生文件可能留下。--rebuild 失败也可能让旧 binding 与新 manifest 暂时不一致，GET 会拒绝；应保持服务停止，在离线副本修复原因并完整重跑，不能把部分索引当可用版本。成功后数据库有新增 binding，下一次回填需新的匹配一致性备份。

## 合成空间与验证证据

专门测试覆盖：随机读取字节上界、SQLite 块数上界、深 offset、有 surrogate pair、旧 hash/缺 hash/错误 UTF-16 cursor、原文件变化、块篡改、text/hash/meta 协调篡改、EEXIST 冲突、复制身份变化与显式重建、缺 context、execution store 重启持久绑定、task output 页不得完整 artifacts.read、跨 task/ref/revision 拒绝与读中 revision 变化。

合成 168000 UTF-16 units（重复 ASCII 行）：原 artifact 176014B；显式同时索引 message-output 与 node:read-files 两个 view 共约 680844B。通常只索引所需的一种 view；默认无输出标记的 input artifact 新增 sidecar 文件数为 0。相同合成文本原 run 已存在时，SQLite allocated pages 从 196608B 增至 425984B，派生索引增加 229376B。此处 page_count*page_size 是合成内存 SQLite 分配量，不是线上空间预测，也未计算生产文件系统簇/日志/备份开销。文本派生副本和 UTF16LE 会放大磁盘使用；真实离线迁移前应对副本统计唯一文本/所需 view、预计索引大小和临时/备份空间，不可声称无成本。

最终独立日志：`pagination-artifact-pages-child-14.log`（由父线程读取终态）；早期 child-6 在契约改动期间运行，含 STORE_UNAVAILABLE，不代表最终回归。child-12 包含已修复的新增 fixture 错误，不当作绿色验证。父线程负责统一最后的 worker/相关整组回归与测试映射检查。


## Windows 显式替换的瞬态占用

`pagination-final-integration-37.log` 保留了 680 总 / 679 通过 / 1 失败：篡改模拟中目标 manifest 的 rename 返回 EPERM。只读检查未发现本代码仍持有该文件句柄或测试清理提前；无法据该结果确定是沙箱或外部占用。

后续最小修正仅作用于 win32 的显式 replace rename：EPERM/EBUSY/EACCES 按 25、50、100、200ms 等有界等待，总等待预算 1000ms；其他平台或其他错误不重试。不会 unlink 目标、退化完整性校验或吞掉最终原生错误。新专门日志 `pagination-artifact-pages-child-16.log`：13/13 通过、0 跳过，包含注入短暂拒绝后成功、永久拒绝精确预算和原 Error、非 Windows/ENOENT 单次失败；真实 Windows FileShare.Read 合成句柄先拒绝 rename，释放后重试成功。单文件通过不是重写原整组结论，父线程另行记录最终统一验证。


## P2：离线回填内存边界

`installObserverEvidencePages` 不再对全部message_runs/message_items正文一次.all并解析。按初始max(rowid)高水位和rowid游标，每批最多32条；SQL过滤无需文本索引的run与无关kind，读完批次后才写派生表，没有活动iterator跨写入。测试记录最大32、解码50个run/195个item，跳过无关记录且保留180个text/130个binding。

这不是迁移总耗时或字节上界：一条大JSON仍可较大，完整离线原子事务仍需扫描/写入所有合格记录。真实库迁移的空间和排他时间仍须另验，本轮未接触真实库。
