# #317–319 与 PR #272 整合验证

## 基线与范围

本次独立 worktree 从 `d27d71aaa851cba9dd089930473db6a490c0b367` 创建，再快进到现有 PR #272 的 `122c1ce66a89a7b9d52f714aeceed5b3245080f0`，保留原作者全部提交。主检出未编辑、未切分支。用户授权只整合这一个 PR，不合并、不部署、不重放原消息、不发群消息、不启用 Team。

历史三条语义总时长为232.498/183.898/164.338秒；接收延迟0.646–0.723秒。前两版话题决策因新消息到达替换，最终共享67.951秒协调轮次。该轮7次模型响应跨度53.875秒、9次工具3.369秒，含两次空参数review错误和任务目录重复查询。话题应用完成至source完成投影约30.7秒；历史内部trace不足，不能证明整段都来自某一个调用。消息真实回执与语义完成是独立时钟。

## 合并方式

PR #272 已实现固定请求空参绑定、查询条件保留与精确续页、首次完成时间不可变及来源即时投影，本次直接复用，未另做回调或时钟实现。

本次补入每一新话题版本的 `linkedTasks`：最多8个、1600字符预算的关联身份及精确 `readCall`；从当前群任务重新读取的小上下文完整内联，总计3000 UTF-8字节。大正文只给读回入口，不截断成貌似完整的正文。整体决策预算紧张时先移除可选任务快照/索引，保留新消息与授权事实。未关联的任务仍按目录查询，不声称关联索引覆盖所有可能目标。

此处没有跨会话隐藏缓存。Topic升级时重新取得Task状态与版本，不转移旧请求读过的许可、审批或有效性；Task在输入发出后变化仍由现有提交门禁拒绝。没有改 `execution_feedback_pending`、执行反馈guard、Owner或资源锁。

## 可复现前后对照

### 来源完成投影

同一个真实原生宿主测试，用模块loader仅换回 `d27d71aa` 的原始协调适配器，与当前 PR 实现比较；服务、存储、脚本模型、5秒观察门限和断言保持相同。合成快话题已完成，另一个独立慢话题仍在阻塞。

- 前：来源仍 `processingPending=true`，5秒观察超时，exit=1；快话题决策确实已completed。`projection-before.log`。
- 后：快话题完成后 **11ms** 写入source完成戳，慢话题仍阻塞；exit=0，1/1通过。`projection-after.log`。
- 该实验可证实“未接完成回调而等待整个协调器空闲”的阻塞路径；不等价于已查明历史30.7秒每毫秒归属，也不是线上延迟承诺。

### 关联任务读取

`scripts/compare-linked-reads.mjs`分别加载 PR #272 原head与当前实现，构造同样27任务、3条未答来源，运行同一个确定性读取策略。不是调用真实模型：

| 实现 | 目录读取 | 完整正文读取 | 合计 |
| --- | ---: | ---: | ---: |
| PR #272原head | 4 | 1 | 5 |
| 补充关联入口后 | 0 | 1 | 1 |

两边均选到完整相同目标，三条来源仍保留，业务效果和发送均0。大正文完整读取没有省掉。结果为 `linked-read-comparison.json`；不把4次工具往返折算成未实测的模型秒数。

## 实际验证

- PR原head相关4文件：188通过、0失败、0跳过（`pr272-baseline-tests.log`）。
- 最终7文件：381通过、0失败、0跳过（`final-unit-tests.log`）：topic runtime/store、HTTP、coordination context/sessions、source projections、dynamic store。
- 当前真实native profile、13项原生路由服务：13通过、0失败、0跳过（`final-native-routing-tests.log`）。新增两次话题修订均直接按关联readCall读取完整原目标，目录查询0；原Task数量/需求版本不变、发送0。
- 新增单元覆盖连续新消息、旧请求拒绝、Task更新失效、完整小快照、超量索引、超长目标无截断、跨群隔离；既有native覆盖重复接收/恢复幂等、混合来源等待真实Host、通知时钟独立与快慢Topic隔离。
- `git diff --check`通过。开发依赖按冻结lock安装在本worktree；未启用被pnpm默认禁用的安装脚本。

调试中新增夹具曾因缺少occurredAt、错误使用决策reply/reason分支或不完整Task result而失败；均修正合成输入，未放宽断言、超时或生产门禁。最终日志以以上完整回归为准。

## 再生成

在仓库根运行，需 Node.js 24+、冻结workspace依赖；原生用当前有效profile的package.json路径设置 `DSH_NATIVE_TEST_PROFILE`。临时目录用本worktree内目录，勿指向业务状态。脚本只生成合成数据，不读真实业务消息或凭据。

```powershell
node docs/acceptance/semantic-latency-317-319/scripts/compare-linked-reads.mjs
node --test --test-concurrency=1 test/topic-runtime.test.js test/topic-store.test.js test/http.test.js test/coordination-context.test.js test/coordination-sessions.test.js test/task-message-projections.test.js test/dynamic-task-store.test.js
node --test --test-concurrency=1 test/task-topic-routing-native.test.js
node --import ./docs/acceptance/semantic-latency-317-319/scripts/source-clock-baseline-loader.mjs --test --test-name-pattern='来源语义戳在首次Topic' test/task-topic-routing-native.test.js
node --test --test-name-pattern='来源语义戳在首次Topic' test/task-topic-routing-native.test.js
```

倒数第二条是预期失败的对照，只替换原始适配器模块，不改生产文件。比较脚本临时提取原head模块到本工作树并在finally删除唯一临时文件；不写Git配置。

## 边界

未部署、未重放317–319；本轮没有新的真实模型测试，不沿用PR原有真实模型一次通过来宣称本次快照机制的真实秒数收益。#320历史135.405秒入站归因仍独立未收敛。保留PR Draft状态及原有失败证据，不触发CI。
