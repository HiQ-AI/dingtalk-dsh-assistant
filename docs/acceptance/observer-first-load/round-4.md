# 插件后台全量历史展开：定位与修复

## 范围、版本与结论

现场运行仍为 PR #333 合并提交 `c0fc2e86c1969f479c6f641ceefabec0dc3b9455`，PID 8976；本轮实现和验证针对 worktree-plugin-background-blocking 的未提交源码。没有修改运行安装目录、业务库或官方宿主，也没有部署本轮候选。

用户 HAR 中话题详情/任务列表同时等待约 3.73 秒，随后同接口约 6 ms；中途 health 同时等待至相近终点，排除单纯响应下载慢。此次不开浏览器，只读 HTTP 与 30 秒 CPU 同期取证，仍出现小接口共同长尾，最大约 5.59 秒。CPU 采样有开销；这不是无采样的生产延迟基准，也不是逐毫秒因果追踪。

明确的插件热点是：恢复 pending 先读全表再在 JS 筛选；每轮恢复/调度五处重复 execution.list，把已经排空的完整执行输入和结果反序列化、再 JSON.stringify/parse 深拷贝。现场 21 个执行均为 drained 的 succeeded/stale，正文约 6.54M 字符；1670 个操作正文约 7.02M 字符；778 个来源约 6.65M 字符。无需当前业务候选也会支付全部成本。

## 反证与责任边界

- 网络/正文下载：HAR 两个慢响应仅 1704/322 bytes、等待首字节约 3725/3724 ms，不支持“大响应下载慢”。
- 宿主完整会话目录：此前已确认另一慢点，但此次不调用该 API 的轻量请求仍重现共享等待；不能把所有插件慢请求都推给宿主。
- 插件周期全历史展开：CPU 有明确 recover/query/all/clone 调用栈；同一新增原生恢复回归在基线两模块下失败于 `terminal history body expanded`，修改后通过，支持独立根因。
- 同期还观察到 JSON 后端 serialize、stat 等开销，未完全归因。修复本热点不等于已证明所有 4 秒长尾消失；未修改运行态，不能宣称现场已恢复稳定。

CPU 样本跨度 31885 ms，recover inclusive 4519 ms / 14.2%，store query、all、clone 多处热栈；inclusive 重叠不相加。采样结束独立确认 inspector 9229 关闭。

## 实现与合同

1. 复用既有 execution.index 的 100 条分页，补后台需要的 definition/providerRecovery/progressReview/cancelRequested 元数据。恢复与调度先看索引；提供方终态审查和进度读取只在候选命中后 execution.get，资源锁仍按完整权威执行读取并由原 claim 再校验。不缓存过去快照、不跳过 DSH/CLI 后端或分页后的执行。
2. recovery.pending 先在 SQLite 排除明确 drained/终态，再用原 JS 谓词校验；保留 missing/null/false/0 的未排空语义、queued、unknown、starting、prepared、superseded 通知及既有隔离审计。不是把“已结束”一概视为外部效果安全。
3. source.list 按群在 SQL 先筛选，再保留原 routed/status 谓词；完整来源/正文 API 不变，来源重新结算不跳过。
4. task.list/execution.list/source.list/recovery.pending 的嵌套数据均来自新 JSON.parse，去掉其末尾重复 stringify/parse；资源 catalog 等可能引用共享对象的其他查询保留深拷贝。嵌套隔离测试验证修改一个返回值不会影响后续读取。

## 验证结果

- 相关存储、资源、分页、可观测性：`node --test test/dynamic-task-store.test.js test/dynamic-execution-resources.test.js test/observer-pagination.test.js test/task-session-observability.test.js` → 218/218 pass，0 fail / 0 skip；其中存储单文件原先 160/160 通过，新增副本隔离用例后随本组验证，不重复累计。
- 原生提供方恢复、进度、资源准入：三个文件、`--test-concurrency=1`，指定 native-profile → 23/23 pass，0 fail / 0 skip。
- 新增真实原生服务回归：插入 103 条跨页 drained 终态历史，recover + whenIdle 期间拒绝正文进入 JS；1/1 pass，0 模型调用、0 终态正文展开。将基线两个源码模块通过 Node registerHooks 原样加载，同一用例为 0 pass / 1 fail，栈落在旧 recovery.pending/all。没有修改断言或放宽超时。
- 真实原生 unknown/排空/持久回执补充回归（两个文件按名称筛选）：4/4 pass，0 fail / 0 skip；包含前述新增历史回归，不能与单独 1/1 相加。

## 隔离体积对照

可复用脚本 `scripts/compare-background-scans.mjs`。基线参数是从上述提交读取的原 dynamic-task-store 源码，Node registerHooks 只替换此模块；前后均运行真实 openDynamicTaskStore 和 SQLite。数据独立新建并在 finally 关闭/清理：21 个大正文终态执行、1670 操作（3 unknown）、270 delivered 通知、778 来源。每轮执行 pending、五次执行扫描与两个群来源读取，不模拟完整生产 recover，也不向现场写夹具。

| 三轮指标 | 基线 | 修改后 |
| --- | --- | --- |
| 时间 ms | 261.45 / 268.92 / 236.18 | 88.71 / 105.21 / 100.54 |
| 每轮 JS 解析 bytes | 99112464 | 6666675 |
| 每轮 JSON.parse 次数 | 3631 | 886 |
| 待核验 unknown | 3 | 3 |
| 五次执行候选 | 均空 | 均空 |
| 两群来源计数 | 389 / 389 | 389 / 389 |

约 93.3% 的 JS 解析量消除，只证明这条后台读链成本下降；不能将该比例套到真实接口延迟。没有全量替换 JSON backend 或新增缓存/迁移/调度器。

## 产物与交付边界

最终 CPU/HTTP 基线与隔离对照在 round-4/。原始 HAR 留在用户指定路径，不复制凭据或业务正文。临时基线 loader、日志和中间库在验证摘要核对后清理；此前轮次报告保留，其他任务资料不动。当前目标为修复后 PR 交付；不自动合并或部署新的 PR，不触发 CI。现场新版本延迟与浏览器复验尚未执行。

## 交付回读

产品代码提交 `33a1735d00a2f44b359d01a101d508817c1d4dd1`；后续仅更新验收文档，不改变已验证产品源码。PR #335： https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/335 ，独立回读为 OPEN / MERGEABLE，base main、head worktree-plugin-background-blocking。验证汇总及两产品源码 SHA256 保留于 round-4/validation-summary.json。尚未部署或现场复测，临时源码 loader、测试日志与中间库清理；其他任务及历史部署资料保留。

## 对照再生成

在仓库根使用 PowerShell 7：先 `New-Item -ItemType Directory -Force docs/tmp`，再 `git show c0fc2e86c1969f479c6f641ceefabec0dc3b9455:packages/dingtalk-dsh-assistant/dynamic-task-store.js > docs/tmp/background-scan-baseline.txt`。执行 `node docs/acceptance/observer-first-load/scripts/compare-background-scans.mjs docs/tmp/background-scan-baseline.txt` 得基线 JSON，执行同一命令不传最后的文件参数得当前 JSON。脚本创建自己的隔离目录并在 finally 删除，不依赖本轮临时目录保留；生成结果与本报告是不同机器/轮次的独立样本，不覆盖原轮次证据。读回结果后删除本次生成的 baseline.txt。
