# #320 入站与承接修复验收

## 结论与边界

承接工具、重复目录读取与完成时间漂移的修复已通过定向、原生和同模型隔离验证。历史入站135405ms的精确阻塞点仍未收敛；不能把当前同图2.150秒当作历史故障已消除。正式实例未安装本轮代码，未重放#320、未创建重复业务任务或补发通知。前轮#313部署边界继续保留，不写全绿report。

## 实际耗时

- 同一图片经真实DWS与隔离原生Host接纳：调用壁钟2149.596ms、ingress2123ms；资源读取1738ms、图片准备保存331ms、消息存储22ms、来源记录26ms。附件摘要与现场一致。见[入站证据](latency320/ingress-evidence.md)及[小结果](latency320/native-ingress-probe.json)。
- 同生产路由cortex-gateway/cortex-cowork、low，图片准备后到独立Topic判断完成32796.969ms：route14655ms、decision17761ms、3次stream，无效调用0、同请求/查询/偏移重复目录0；唯一只读排查动作被隔离适配器捕获，真实Task写入/渠道发送0。该轮不包含DWS图片下载，不能与入站数字相加冒充同一次端到端实测。见[第六轮模型结果](latency320/round-6-model.json)。
- 第四轮74566ms仍有两次并行空参，保留FAIL；第五轮原始SSE证实参数原本即空，排除适配器后置丢参，不能把故障归因提供方丢失required。第六轮候选摘要与完整readCall后通过，单次通过不保证模型未来绝不犯错。

## 修复与反例

- 资源读取、图片准备保存、消息串行存储、来源读/写分别留时钟；整体记录共享事件循环最大采样延迟。已知来源直接写stage，避免每个子阶段重读全群来源。历史网络、图片准备、Host共享阻塞三个候选及反证见入站证据。
- 固定请求的审阅读取和固定Topic读取可用Host绑定身份；路由无唯一Topic时仍明确拒绝缺参，返回合法候选模板。任务分页返回query、目录指纹与完整nextCall，不缓存真实变更，也不跳过已有Task完整目标/版本核验。
- 首次完成事务写completedAt；重复完成零写入，历史缺失不回填。精确来源未完成时不先报Topic数字；通知、恢复、后续更新不推进完成戳。首次完成的来源投影不等同群其他Topic结束。

## 本地实跑

原始日志位于忽略目录`docs/tmp/quoted-deployment-handoff/latency320/`，以下均非CI或部署结果。

| 范围 | 结果 | 日志 |
| --- | --- | --- |
| 时钟store+HTTP | 80/80 PASS | sg7-final-clock-tests.log |
| 时钟关联5文件串行 | 127/127 PASS，0 skip | sg7-final-serial-tests.log |
| 入站projection+dynamic-store | 148/148 PASS | phase-tests.log |
| 最终DTO增补 | 21/21 PASS | phase-projection-final.log |
| 入站失败→新版本成功→重复入站 | 1/1 PASS，0 skip | phase-native-tests.log |
| UI及资源构建 | 35/35 PASS，0 skip | phase-ui-tests.log |
| 最终工具合同unit | 136/136 PASS | topic-runtime-round-3.log |
| 最终完整Topic原生 | 12/12 PASS，0 skip | topic-native-final.log |
| 快慢Topic首次来源时钟 | 1/1 PASS，1796.8ms | immediate-clock-native-round5.log |
| 旧网页读取失败路径孤立复验 | 1/1 PASS，19110ms | associated-web-single.log |
| 原执行提醒与完成竞态孤立复验 | 2/2 PASS，0 skip | associated-races-single.log |
| 实际双包隔离运行 | 2/2 PASS，0 skip | package-smoke-isolated.log |
| 发行smoke串行、预打包产物 | 14/14 PASS，0 skip | release-smoke-artifact.log |

初次并发运行曾使旧原生路径超时，已保留associated-service-regression.log、topic-native-round-2.log，未提高超时或删除断言；孤立复验通过不足以单独证明原失败都是机器负载。新增首次完成测试最初因夹具残留replyReview不符合纯讨论union被拒绝，按真实合同修正后通过。初次默认release-smoke包case30秒超时，孤立包验证通过，最终串行结果另列交付记录。所有历史失败均不得改写为PASS。

最终发行smoke使用原测试已支持的`RELEASE_PACKAGE_DIRECTORY`，先以`npm pack --json --ignore-scripts --pack-destination <docs/tmp下候选目录>`产出实际tgz，再设置该目录并运行同三文件`node --test --test-concurrency=1 ...`。共14/14 PASS、0 skip，原30秒门限未改；打包及解包后的全部运行文件逐字节核对当前源码。默认pnpm命令及无预打包串行轮均曾超时，日志保留，不能称默认命令一次通过。这是本地候选包验证，不是精确提交SHA的发行CI或已安装版本。

已独立读取候选`zzusp-dingtalk-dsh-assistant-2.2.1.tgz`摘要为`c7135f07afa3c143b58a06b730f196106a80c33a1460651c77f7993a427d453e`。测试映射检查309文件各一次、历史3、删除0；没有调整分类退出覆盖，也没有主动触发CI。

## 交付回读

代码提交`75d46b338c62efbd5da3a795f73712f261e42aa3`。`gh pr view --json number,url,state,isDraft,baseRefName,headRefName,headRefOid`独立回读[PR #272](https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/272)：OPEN、Draft，main ← worktree-inbox-latency-320，head为该代码提交；`git ls-remote`同名远端分支摘要一致。Draft保留历史135秒未收敛及现场未部署边界，不表示业务验收完成。
