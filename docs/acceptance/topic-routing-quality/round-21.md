# 第21轮：初诊覆盖与调度关闭等待修复

日期：2026-11-06

## 范围与源码绑定

本轮围绕 #868 首回慢问题修复 Route 初诊处置覆盖、通知扫描诊断语义及已接纳调度关闭时序。产品提交 `8320096ae560fdd8318f6f4dda52d7530adb9adb`（16个源码/测试/spec文件）；Lead 独立核对提交内容。PR #346 当前独立核验为 OPEN/MERGEABLE，base `main`；核验时head为产品提交 `8320096a`，后续仅文档提交另计；本轮未合并、未部署、未运行CI。实跑发生在提交前冻结工作树；Lead核对206个包源文件按仓库Git属性与产品提交树对应，最终实跑工作树原字节SHA256与最终包逐JS测试指纹一致；不宣称工作树原字节与Git提交对象逐字相等，早期失败组合另列，未因提交重复测试。工作树基点 `9232c700b3b4f82ad0d64bc0aa8658376dcb9bdb` 不能单独代表受测状态。

新 Route 每次提交必须显式提供 `initialReplies` 和 `initialReplySilences`；没有业务 Topic 时也显式提交空数组。每个本批真实业务 Topic 要有一条绑定本批来源的初诊回复，或一条带非空语义 `reason` 的静默；Host 校验来源、Topic、覆盖、冲突及批次版本，可修订拒绝无效提交且不落路由/出箱。历史成功 receipt、冻结发送及既有恢复不重判或重发。静默不授予 Task 权限。

## 最终验证

| 验证 | 结果 |
| --- | --- |
| Runtime 完整文件 | 223/223，0失败/取消/跳过，24,034.263ms；runtime blob `d0747c2c703516e5d334cd0d8bf71c5c78a95f46`，test blob `fe897e593adb062f82cf755d324b0946abf04210`。完整原始输出 SHA256 `a6d9d757cc0a3bff7cb14879b75afbd583cf07a50adba999b64c82424f99f038`。确定性 close join 两用例在此完整输出中通过。 |
| Route Native 完整文件 | 44/44，0失败/取消/跳过，100,044.2563ms；runtime `d0747c2c`、test `d2c6971be1fa206b61f4b8b5198b1807cd30a581`；Lead/D核8个源码、test、lock、profile blob 首尾一致。输出 SHA256 `ef3f4338d1866d372dce31b0ff00120ee3f23c2f4b1964a5aad6496e4415c0ef`。 |
| Service 直接受影响路径 | Service 12/12；另一个原生受影响用例1/1。Service 2,610.9419ms；Native 整次运行6,128.869ms（其中business 149ms、cleanup 62ms），0失败/取消/跳过。输出 SHA256 `2f2105fb1ff3dd5f2ee0561e6b868d18cd0294be53af61932331f3fce7281e95`。仅覆盖直接受影响场景。 |
| Store 最终定向合同 | 6/6，0失败/取消/跳过，922.0084ms，test blob `e9dab9b2f234a0772a445d3beb44d3c271baa96f`；覆盖 silent 冷重开及 reason 变化身份冲突。输出 SHA256 `789caf4793fd3806923ca254f8e25c9d08e561e4990210f0d510a2ca6e5ea204`。 |
| 角色上下文 | 3/3，802.8306ms；coordinator blob `b3fd9c151b681d1ce71d173ee40edaae6b1f1a7a`、test blob `3f2faeaba2e86bbac49f6f3015ab515cd4291792`。B前台原工具结果，无独立日志；仅证明提示合同，不代表 Host 或模型验收。 |
| Release workflow 与映射 | release-workflow 8/8，0失败/取消/跳过；`pnpm test:suites` 核对343个文件各登记一次、历史3、删除0。输出 SHA256 `26ef3d8ea127ea592579112c03f44b48f1b1d5d95b7239b0e6ff9bcb25a33d1d`。不代表完整业务回归。 |
| 最终预打包产物 | 使用仓库既有“先 pack、后以 `RELEASE_PACKAGE_DIRECTORY` 验证”路径，2/2，0失败/取消/跳过，31,111.9814ms；Task业务22,098ms/cleanup444ms，health业务7,578ms/cleanup205ms，原30,000ms断言及业务断言未变。Assistant 包 SHA256 `55258971525a052a3e7e5bfa8a5c2565be139608db8c12cf24098090c4817830`、516,869字节、96文件/93 JS；206源文件指纹与包摘要独立回核一致。输出 SHA256 `71571d03229d066205641697c8f31fe2c3c3e64083759e05a696708807b492e7`。 |

## 保留的失败与未收敛项

- 两次较早 Native 完整运行均为43/44，失败项不同，出现 `DomainError closed`。首次为 `b331lz0k4`（输出 SHA256 `f87f7acea1dbb89edd29b36ead011b6576b1c09c615a35bfc4d589ded22f8017`），第二次为 `bllrmxrt4`（输出 SHA256 `b86b54cb099982333d1957b09f86d254373854dc032a21d6ce1f0eb25ae1f807`）；后续诊断 `bkx3sd54l`（输出 SHA256 `d1bb455aee0718b2bf064d858fd0423dbf9bca4929ab97c58d2497e233bb2b2c`）未复现原 wake。最终 Runtime/Native通过不证明这些历史偶发失败只有一个根因。修复为 close join 已接纳 scheduled 工作、active tool calls、applying 工作及异步错误处理；完整单测与最终 Native 通过。旧测试中等待 close 后才释放自身门闩的用例只调整了门闩释放顺序，原“不派发”断言保留。
- `runtime-history` 最新已核运行是127项120过/7失败；此前组合161项154过/7失败，Runtime部分34/34。干净 HEAD 基线也有7失败，但失败点部分不同，不能据此排除所有回归或把7项归因到同一缺陷。此 Legacy 组合未在最终 Runtime `d0747c2c` 上复跑，失败明细及绑定见 `round-21/validation.json`。
- Runtime+Store 较早组合280项279过/1失败，唯一失败仍为既有固定摘要断言（actual“第一版”、expected空串，`test/topic-store.test.js:793`）。最终 Store 相关定向6/6通过，但未在最终源码上重跑旧Store整文件，不将历史失败写成已修复。
- 首轮 release smoke 12/14失败保留：一项 `mixed_fixture_changed`，另一项首次 pack 约27.660秒后业务30秒超时且未进入业务；cleanup正常、health通过。最终使用预打包入口仅2/2，另有release-workflow 8/8；不得合并成单次14/14。首次直接 pack 超时的具体原因未收敛。
- 初期 `blocked≠new-notice` 隔离红1/1（business552ms）只证明扫描队头阻塞场景；一个候选绿1/1之后被D finding否定并修复，不作为最终通过证据。不能据隔离旧红把原生产通知的全部长等待归因于该场景。

## 诊断与边界

新增诊断仅在 debug 开启时可见：`itemWaitMs` 从本轮 notification scan 开始计至该项处理，包含本轮 `notification.list` 查询及前序项耗时；`queueMs` 从本轮首个合并唤醒计至扫描开始。许可与传输时间为墙钟耗时，不是 CPU 时间；诊断不含正文、群或来源标识，也不新增 `source.stage` 持久化命令/阶段，Dynamic 已有持久数据使用 `source.stages`。

第19/20轮产品（merge `d95a2b28`）仍是已部署版本；本轮产品提交及新包未部署。真实模型语义、真实钉钉收发、真实新消息初诊及生产60秒目标未验。生产观察的首条通知 prepare→permit 108.524秒、ACK→回读启动42.699秒仍未由本轮隔离证据收敛，原随机 wake 的根因未知。2026-11-06 11:00:39.9842524 +08:00 的正式实例只读健康核验为 degraded（inboundProcessing=true、dwsBridge.healthy=true、recoveryIssueCount=1）；恢复问题类型 task-session/active，脱敏错误为 DYNAMIC_SOURCE_STAGE_CONFLICT。该实例未安装本轮修复；本轮未停止、重启、恢复或重放，现象与本轮修复因果未知。未运行CI/tag、未重放业务消息、未补发通知、未手改业务账。Store历史FAIL和runtime-history失败保持，不写全仓全绿。完整结构化计数、输出SHA、包与源码绑定见 `round-21/validation.json`；未写整体 `report.md`。
