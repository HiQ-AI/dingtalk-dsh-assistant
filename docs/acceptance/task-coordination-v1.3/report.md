# 真实 A→B→C 验收报告

## 结论

2026-10-25 第九轮真实群 E2E **PASS**，最新轮矩阵 20/20 PASS。保留第五轮 CLI 回声失败、第六轮入站阻塞、第七轮沙箱失败以及第八/九轮安装和测试失败记录，不以修复覆盖历史。

本次在唯一获授权群“DSH端到端测试-20260927”（`cid2HnVI0zvC2dOr5RmJ5ZCJg==`）接收一条真实客户端消息 `msgtrvT+6JRj5yJB5DDwxEAeQ==`，时间为 2026-10-24 21:07:41 +08:00。该消息自动创建以下三个独立任务及 A→B→C 依赖。原 A 因环境问题停下后，仅通过原 operator 人工申请的受支持 `reply/check` 和正式 `reply` 恢复 A；没有创建新链、人工启动 B/C 或直接修改完成账本。

| 任务 | 原 Task ID | 原 Owner Session ID | 最终状态 |
| --- | --- | --- | --- |
| A | task-cfe4f8e8b0993c6458d8391f9e885516 | task-session-e58b5403-aaa4-447f-a4b7-483800ce9862 | completed / drained |
| B | task-3379b3ead0e8713b6df0783f2ec88721 | task-session-ab2a29c7-ab8c-47fc-afbf-88a0da16d3bf | completed / drained |
| C | task-4d198f4ac51b9830ac50de22ff9e223a | task-session-f45c267e-6012-4304-8ddf-475771af2529 | completed / drained |

三任务 requirement/control/context/run 均为 `1/1/0/1`，保留原始 cwd 和日志。没有独立 execution 行，不能把 Owner 认领冒称为独立执行成员的 running 时间。

## 修复

1. **精确 Windows ACL 根因**：原生 grant 同时写 DACL 与 Low integrity label。Host 非提权账号是目录 Owner、有 WRITE_DAC，却没有 WRITE_OWNER。先只读 Check，再仅为原三 Task 根以及正式共同 outputs 根添加当前 Owner 的非继承 WRITE_OWNER；保留 Owner、deny、label、父目录与其他权限，并独立回读。未关闭沙箱、广放权限或请求管理员。
2. **团队统一产物边界**：复用正式 `taskFilePath(workspaceRoot, coordinationId, 'outputs')`。同团队全部 Task 只写一个产物根，不再使用团队自行选定的 docs 路径或分散 Task 目录。原生 policy 的正式本地补丁通过已发布的 `sandbox/mode` 事件承载完整绑定；FS 与 shell 消费相同 resolve 结果，不修改全局共享方法或不可变 session header。
3. **受信原链路径纠正**：原 A 的技术答复以严格 `artifactScopeCorrection` 提交，客户端不传任意 root。Host 核验同群、同 Owner、协调版本，派生正式根并记录来源及 history；全队获得同一已认证纠正事实，不变更原 Task 版本、要求历史、依赖或完成状态。
4. **摘要语义**：启动命令接纳不再写成“本次安排已执行”。A 阻塞时的新摘要明确“已接纳处理要求，任务尚未正式完成”；三项正式完成后的新摘要才使用“对应任务已正式完成”。旧已送达错误摘要保留历史，不重发或改写。

## 正式共同产物

唯一业务产物根：

`D:/baibu-agent/tasks/coordination-f1767af593d66d5eabe73d31dfbc9a30/outputs`

| 文件 | 字节数 | 独立 SHA256 |
| --- | ---: | --- |
| a.json | 156 | b7838e92a8c0ade8a502499886bb58d57ba01a63b46bde14fbcb81a5da3baf99 |
| b.json | 178 | 11202fd537081d4da6a91965731edfed6918cbae62ede5c01676797640fdc8db |
| c.md | 1884 | 2917aebeb9d8d7c2e674f47f131612f65a78f20ad5194b0e0bb12bf75926929e |

A 在实际执行时通过密码学随机数生成器产生 nonce：

`e994bf3a6f278384f9adee4251ff2502c34f0f33e2045c8b93a0de0e93bf566e`

B 实际 read A，再用原始字节计算 SHA256、求和 81，write/read B。C 实际 read A/B，重新核验 nonce、总和和两文件原字节摘要，write/read C。原生日志保存对应工具 call/result；lead 与独立审查员分别读文件并重算。共同根文件集合精确为上述三项；旧 docs fixture 路径不存在，原三 Task 私有根/work/tmp/outputs 未发现这些业务文件。Host 原生日志、材料缓存和阅读投影不是业务产物，不迁移。

## 自动因果与实测时延

时间为 2026-10-25 北京时间；正式完成来自权威 `task.completed` 事件，认领来自命令收据，原生工具时间来自日志。

| 事实 | 时间 |
| --- | --- |
| 原 A 技术答复恢复认领 | 00:30:37.720 |
| A 正式完成，event sequence 5 | 00:31:33.660 |
| B Owner 首次认领 | 00:31:38.958 |
| B 首原生工具 | 00:31:50.263 |
| B 实际读取 A 产物 | 00:32:11.727 |
| B 正式完成，event sequence 6 | 00:32:41.425 |
| C Owner 首次认领 | 00:32:45.025 |
| C 首原生工具 | 00:32:53.188 |
| C 实际读取 A/B 产物 | 00:34:15.959 / 00:34:15.984 |
| C 正式完成，event sequence 7 | 00:35:04.926 |
| C 最终群消息 | 00:35:07 |
| 协调完成摘要 | 00:35:10 |

- A 完成→B claim：**5.298 秒**；到首原生工具 16.603 秒。
- B 完成→C claim：**3.600 秒**；到首原生工具 11.763 秒。
- 恢复 A claim→C 正式完成：267.206 秒，不含人工修复及部署等待。
- B 的 business-event trigger 精确引用 A 的 `task-completed:complete:task-cfe4f8e8b0993c6458d8391f9e885516:1`；C 精确引用 B 的对应完成事件。成员 proof、command、版本及 instructionId 匹配。
- wake 账仅原 A 一次 `human.responded`；B/C 只有协调命令产生的 `task.created`，没有人工 continue/start。Task 创建时间不是执行开始时间。
- 原消息→安排 69.086 秒、到首次 A 认领 70.255 秒，含未拆分传输/路由/规划；不能全部归于协调事件队列。5 秒配置只是恢复扫描周期，不是端到端上界。C 首产物工具较晚包含只读账本探索，不归因于依赖释放。

## 真实通知独立回读

DWS `messages-mget`：`complete=true`、`foundCount=3`、`failedCount=0`、`notFoundCount=0`，三个消息均在指定测试群：

- 修正后的阻塞摘要：`msg8S6sWsqf9+Sjoyl+t3d84A==`。
- C 最终业务结果：`msgt7ZSZOaRko7X/Ds+dvxwKA==`。
- 协调完成摘要：`msgoiajQr7RaLQlyYIfz2en1g==`。

原有 A/B/C 完成通知各发送一次，已投递；没有为验收重发旧通知。内部 Task ID 和包含它们的完整路径仅在共同根 `c.md` 和本机审计中保留，群消息按现有隐私门禁公开标签、nonce、总和、SHA 与文件名。早期一次自动 operator 单聊求助保留记录，不是其他业务群外发。

## 部署及程序验证

- Assistant/Observer 版本均 2.1.0；Assistant tgz SHA256 `013ac10fdb97b2a0520a427db3d73c9872a1518eb4696de825ee279f4897c6f9`，68 个已安装文件与冻结包/源码独立一致。
- 原生 policy 本地精确包 `0.2.1-rc.2.artifact.2`，tgz SHA256 `9b4d2969577061b9e376bcca155027e450a760ea0a4208cf3015e385a998a78f`，真实 consumer 入口 SHA256 `225d0fbdb82dc459dcfadcc1834b821305576e19b176e5199fe090cd789019af`。
- 当前 PID 84680；独立 health=`ok`、recoveryIssueCount=0、modelMode=real、inboundProcessing=true，桥正常。
- profile patch SHA256 `74fe100c0019f5e4c76c06903fdb622b0af5696afc60ab38cbd252ce8f948499` 不变；Observer 原包、已有 PTY overrides 保留。原生 SIGINT disposal/停止态账本/旧 PID 退出/受控安装均有收据，未建历史副本。
- 最终受影响隔离回归 **122 PASS / 0 FAIL / 0 SKIP**；最终发行烟测 **14 PASS / 0 FAIL / 0 SKIP**，含冻结真实 tgz 解包运行；测试映射 307 文件，历史 3，删除 0。组合有重叠，不加总成唯一测试总数。未运行 CI 或无关全量。
- 中途安装失败、未知事件恢复失败、依赖环境缺失及超时均保留，并记录后续精确修复与复跑；未吞失败冒充通过。

## 证据与边界

状态以 `matrix.csv` 最新第九轮为准，详细记录 `round-7.md`、`round-8.md`、`round-9.md`。本机原始证据在 `docs/tmp/coordinator-abc-validation/round-9/`：`final-ledger.json`、`native-tools-evidence.json`、`live-session-bindings.json`、`event-latency.json`、`final-artifact-check.json`、`final-group-mget.json` 及完整测试/部署日志；含原始会话与消息的 JSON 不提交 Git。跨轮只读取证与 ACL/原生边界脚本已入 feature/scripts，policy 再生成配方在 `scripts/sandbox-artifact-policy.mjs`。

两名真实原生 `sequence-worker`（low、in-process）分别直接只读复核契约/事件/日志与文件/群通知，均确认真实 E2E PASS。lead 保持 high 并独占部署、恢复和外发；主检出代码和用户资料未修改。

通过范围是本次原三 Task 的无破坏真实串行场景，不声称穷尽周期、取消、多协调归属或外部 CLI 团队写边界；不支持的范围保持明确拒绝。最终完成摘要有重复的“对应任务已正式完成”三行，语义正确但仍有精简空间，未为美化追加业务副作用。

原生Windows ACL后端仍是其公开声明的partial enforcement：读侧、网络及硬链接别名边界没有因本修复变成完整隔离。本轮已实跑常规FS/shell根外写拒绝和junction拒绝，并核对实际业务文件集合，不把它扩大为所有系统调用/对象别名的安全证明。
