# 第23轮：初诊决策审阅与计时合同修复

日期：2026-11-06

## 范围与源码绑定

本轮验证当前工作树对初诊决策审阅、候选请求预算、协调排队/turn 计时身份的修订；只做隔离测试、测试映射检查与预打包 Assistant smoke。未合并、部署、触发 CI、查询生产、调用真实模型或发送真实钉钉消息。

- 分支 `worktree-first-reply-contract-repair`，本轮测试时 HEAD 为 `825385db44f6c0d73fd47090269a68b43496fefe`，产品与测试改动尚未提交。测试结果绑定工作树文件 blob 与冻结包摘要，不将该 HEAD 当作改动版本。随后 Lead 将已测产品/测试内容提交为 `7010297ee0eab8fa3c08d578766dffcfcf5bec20`；独立检查该提交下相关产品、测试与 suite-map 文件相对测试时内容无差异。本轮未在提交后重跑测试，提交只固定已测字节，不作为新的测试结果。
- 冻结包源 210 个文件摘要为 `22da01ccf8b8ad0086e1ad2beecb05bc05e8d67c3f7cfc844d8492d61f370144`。Smoke 所用 Assistant 包为 517,355 字节、SHA256 `603c9a452ecd10560bba99eb4e8bb6f38503e62475c5ffcb45dd7aecf4ef00d7`；源文件摘要从打包前到 smoke 后未变。摘要和包身份已自包含于 `round-23/validation.json` 的 sourceBinding；原私有中间记录与本次 tgz 已核对后清理，不入库。
- Native 末次运行中最终复核的产品 blob 包括 `coordination-sessions.js` `0c2f4ae295d3e6e5b8cb984301ba3521205b47bb`、`task-topic-coordinator.js` `423bbf756964fe4f771998c9381643bead654126`、`topic-runtime.js` `87b5cbe135ef736ae6340c972ae0f0f25b1e1865`、`decision.js` `d795213acd550bce11c1895b3b2213fcbafdf44c`、未改 `task-session-service.js` `56c4bc390ee2f4cfef165e2c1933b04efbbd8ade`；Native 测试 blob `ed330f9e19799510425dc9d3f4a274c419a9e56e`，fixture blob `a2b928c8e500509dd9bad37f47093bc79b0616d2`。Native 输出 SHA256 经 Lead 独立复核；最初采集仅含前4个 blob，运行期间由 C 报告7个一致，结束后独立复核到7个一致，因此不声称最初也完整记录7个。

## 最终验证

- `topic-runtime.test.js` 最终 226/226，0 fail/cancel/skip，27,791.1913 ms；源码 blob `87b5cbe1`、测试 blob `6e7bb558097e8ce2e1508e01aadc933e35687c8b`。首次 225/226 的失败来自测试沿用旧 7,000 字符分页预期；仅将测试候选中的双引号由 7,000 个改成 35,000 个，使 JSON 转义后确实超过 64 KiB；产品预算未改，最终原有边界断言通过。首次失败保留，不与最终结果合并抹去。最终原日志为 `bh00smu9c.output`，SHA256 `9a234d317e3817b257336c404add49447abd6f5e0afba61378a13838e05a9d47`，Lead已独立读取。
- `decision.test.js` 20/20，0 fail，506.2793 ms；源码 blob `d795213a`、测试 blob `1c44969f15f0136593df47cac6685381bac3312c`。角色上下文测试 4/4，585.369 ms；协调器 blob `423bbf75`、测试 blob `4935b2a43a7073e14e23b8bce9ace2c1eacb4c4c`。两项为成员原始工具结果，当前无独立输出文件，故只记录测试数、时长及 blob，不附造输出 SHA。
- `coordination-sessions.test.js` 全文件 19/19，0 fail/cancel/skip，572.7661 ms；源码 blob `0c2f4ae295d3e6e5b8cb984301ba3521205b47bb`、测试 blob `2e03f078a506c258bafed93358a7701a33e986fa`。覆盖真实来源账本下排队阶段冻结开始时来源、动态追加不改变旧 span 身份或回填来源、延迟计时与队列事件边界。此前单项真实 SQLite 用例暴露 `DYNAMIC_SOURCE_STAGE_CONFLICT`，结果 0/1；修复后同一用例包含在 19/19 全文件通过中。失败与最终输出 SHA 分别保留在 validation。
- `task-topic-routing-native.test.js` 最终 45/45，0 fail/cancel/skip，118,532.6601 ms，exit 0；输出 SHA256 `399b31d33a9f542dc81ee2117f73a2250201c8ad3e1949354fe15b6440530854`。最终 fixture 为 `a2b928c8`，测试 blob `ed330f9e`。修正后的真实工具路径覆盖三类不合法替换均不产生决策/出箱副作用，并接纳合法旧 confirmation。两次早期门禁因测试种子未与当前来源关联、候选为空而分别以 `TEST_STAGE_TIMEOUT` 失败，均保留；首次红测中的“必须发生后续 turn”断言亦经核对后修订，因为 SDK 可在同一 turn 消费 nextStep。最终验证只证明首 turn 完成、无旧 span 回填及相关拒绝/接纳合同，不证明追加来源必然触发后续 turn。
- 测试映射独立检查通过：343 个文件各登记一次、historical 3、deleted 0。最初 stale 检查失败后更新 `test/suite-map.json`；首次失败保留。Release smoke 中映射合同用例也通过。
- 对冻结的实际 Assistant npm 包运行 `pnpm test:release-smoke`，14/14，0 fail/cancel/skip，54,160.243 ms，exit 0；日志 SHA256 `cffec47fc26c3a5bec2a2ab0e7c43e9ef560f95adc391a675b90441806136098`。真实解包包上的 personal-skill task business 26,980 ms，health business 10,905 ms；原 30 秒阈值未改，cleanup 均正常。此为隔离预打包 smoke，不是生产消息或真实模型测试。

## 失败保留、结论与边界

本轮相关最终定向测试、Native 全文件、映射检查和预打包 smoke 均通过；这不等于全部历史合同全绿。第21轮 `runtime-history` 7 项失败、Store 固定摘要失败及首轮 release smoke 12/14 仍按原记录保留；第23轮新增的 Runtime 初跑、SQLite 动态来源单项、两次 Native fixture 门禁和首次 mapping stale 失败也各自留存，未用最终通过覆盖历史红项。

首次组合运行 `bxjrkkv0i` 为242/244，两个 decision 失败来自退役字段与缺显式双数组；只迁移直接调用方并保留原业务负例，产品 schema 未改，也未在旧产品独立复跑此失败。Native定向 `blserwqt4` 为1/2，失败是新加的“追加必须有后续turn”断言；修正错误前提后保留首turn身份和原全部路由断言。SQLite旧红测试为0/1失败，宿主外层命令最终exit0不代表测试成功；各原输出SHA见validation。

原生产108.524/42.699秒等待的具体责任点仍未收敛；本轮service未改，隔离查询/内存算法比较不作为Host提速或生产因果证据。

本轮没有重新验证真实模型语义、生产首回延迟/60 秒目标、真实钉钉收发、部署后行为或业务终态。Native 中 confirmation/replacement 的合同通过不证明模型在真实对话中的选择质量；Native 与 smoke 的通过也不证明线上性能改善。产品仍未合并或部署。

## 证据保留

round-23 报告、`round-23/validation.json` 与矩阵保存最终摘要、blob、运行计数及必要失败证据。测试原始日志由宿主临时任务目录管理，validation 保存任务ID与SHA，不将完整日志、绝对用户目录或凭据入库。包源/包身份已汇总validation；本次打包目录4个白名单中间文件（含tgz）经零副作用自检后清理，并独立核目录不存在。再生成配方见validation.regeneration：从已测代码提交创建独立打包目录，沿用已安装隔离profile，以预打包入口运行原release smoke。旧轮次报告和结果不改，矩阵原round_1至round_22单元全部保留；不清理其他会话文件、未知stackdump或私有业务材料。
