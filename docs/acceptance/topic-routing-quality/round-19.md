# 第19轮：SG7 一级初诊与有界同会话追加

日期：2026-11-05

## 范围与源码绑定

本轮完成一级非结论性初诊、逐 Topic 原生引用、同请求/同 Native 会话追加及每批最多15条来源的实施与相关隔离验证，交付到 PR，不合并或部署。Task 授权、二级新事实处理及 Task final 的 `quote:false` 保持。

产品提交：`f2525c73b4550b7cb9726e95debfdf8d3f431c09`。测试运行于此前冻结工作树，当时 HEAD 为 `62f90cd5cd30cc7113478ab4c296a8d24bfe95a6`，不能仅用该 HEAD 代表受测产品。`round-19/validation.json` 保存210个包源码实际工作树 SHA256、规范化 Git blob、19个组件/测试 blob、包及最终日志摘要。提交后逐项核对规范化源码/测试 blob 与产品提交一致，实际工作树字节也与打包及 smoke 时一致，未重复运行测试。Git LF 与 Windows CRLF 分开记录，不混称原始字节相同。

## 最终结果

| 验证 | 实际结果与范围 |
| --- | --- |
| Runtime | `test/topic-runtime.test.js` 219/219；runtime `46747803` / test `b3bdf8c9`。 |
| 角色/会话 | 角色上下文3/3，coordinator `fe857dab` / test `ddc93e93`；协调会话17/17，sessions `a0f2563c` / test `d19e9bcb`。 |
| Store | 59项58过/1既有摘要FAIL；Store `0f636ff4` / test `d463a6ff`。断言 `test/topic-store.test.js:788` actual=`第一版`、expected=空串，未修改原断言。 |
| 路由 Native | test `7b1f506b` 整文件44/44，0fail/cancel/skip，107530.1393ms；运行前后9项产品/夹具/测试 blob 一致并由Lead独立核原回执。 |
| 澄清关联 Native | test `73b77db3` 整文件13/13，0fail/cancel/skip，16809.043ms；随后仅加取消释放钩子，最终 test `97643f4f` 受影响用例1/1，3446.7202ms。两次不是同一个测试 blob 的整文件结果。 |
| 实际包 smoke | `pnpm test:release-smoke` 14/14，0fail/cancel/skip；实际提取 Assistant 包运行任务，business26956ms，并启动隔离 Resident 验 health，business8305ms。原30000ms业务断言保留，清理正常。Observer已打包/SHA核对，不能据此称Observer功能运行验收通过。 |
| 映射/差异 | `pnpm test:suites`：343文件各映射一次、3历史、deleted0；历史3文件未调用本次变更的 `topicTaskCalls`。`git diff --check` 通过。 |

路由 Native 覆盖：同会话真实消费新来源及旧批拒绝；首请求最多15条、第16条进入下一请求且不丢不重；恢复配对13/14容量；多来源/多 Topic 独立引用；初诊准备前在途事实屏障；未冻结/已prepared失效草稿、starting/unknown原账恢复、冷恢复不重发；原路由/Task关联及恢复幂等兼容路径。

双包均2.3.0，210个包源码在打包前后及 smoke 后SHA256一致，未安装：

- Assistant：514932字节，SHA256 `f1c926ecd6cc60d89753c2bec8280455a7deecbdf91c4d03d630d54e518560e9`。
- Observer：62390字节，SHA256 `84e114942dab9b4ef60f1b6cf9f40fae889181a5c9d52296bd778aa84d24c1f2`。

## 失败、反证与修复

- 首轮 Native 整组31项（21过/10失败）后OOM，中间日志SHA256 `453c28a3149c8fce9e566e83750676c22f3d8980859b36f1df61398560c24d8e`。真实定位到 coordinator 丢在途标记、Service等待idle、首包前UPDATE排队饥饿及脚本丢失同请求初包候选，逐层修正后当前44项完整复验通过；不把原失败隐藏为环境问题。临时堆限制、20次诊断暂停未用于最终验收。
- 首包窗口原单测只在idle后断言，不能证明实时追加；加强到idle前必须见initial和batch-1，旧实现0/1红，新sessions整文件17/17绿。Native脚本合并只取当前同request真实user消息、UPDATE覆盖初包；不读历史缓存或恢复压缩后不可见材料，D已核角色过滤。
- SG6关联首跑12/13，失败摘要日志SHA256 `de8ac500eee51db7edae0cde6ede443a7ce3099c3cc7679307aae83bcb1ddf7d`。旧epoch通知被群锁内 `withRoutingHold` 拦住；即时schedule使脚本重路由后产生新epoch合法问句，旧测试全局发送次数混淆新旧通知。仅测试加门闩隔离旧许可阶段，按精确旧ID核prepared/未attempt、source pending/epoch1及零网络发送，再释放不发问的续路由完成排空。产品和共享夹具未改，不放宽零发送断言。
- 澄清门闩增加 `t.onCancel` 释放，避免失败时资源关闭早于after而卡住；D静审关闭该问题，最终受影响单例1/1。没有单独故障注入，不将正常cleanup当作失败清理实测。
- Store既有摘要失败保留，原始输出SHA256 `074d6444f0264c79f9351210f5e3f90605384d7142d46c0b3a3f755a46192be3`；归档 `round-19/topic-store.log` 仅去除2个空行的行尾空格，归档摘要与原始摘要在validation分开登记；不称全仓全绿。

## 再生成

Windows 11 / PowerShell 7 / Node24.19.0。Native使用既有本地profile提供隔离依赖，不修改正式profile、不发真实钉钉消息。实际包入口使用本轮同一组预打包产物，不从源码回退代替包验证。

```powershell
node --test test/topic-runtime.test.js
node --test test/topic-role-context.test.js
node --test test/coordination-sessions.test.js
node --test test/topic-store.test.js
$env:DSH_NATIVE_TEST_PROFILE = 'D:/dsh_home/profiles/web/package.json'
node --test test/task-topic-routing-native.test.js
node --test test/topic-routing-clarification-native.test.js
node --test --test-name-pattern='发送许可前 epoch 已恢复时拒绝旧澄清' test/topic-routing-clarification-native.test.js
# 将 RELEASE_PACKAGE_DIRECTORY 指向与本轮摘要一致的双包目录，再执行：
pnpm test:release-smoke
pnpm test:suites
```

当前取消钩子版本仅复验受影响单例；上方整文件命令是再生成配方，不代表最终test97643f4f已整文件重跑。

## 边界与证据保留

仅脚本模型/通知适配器及真实隔离Host路径，不证明真实模型语义、真实钉钉收发或生产首回≤60秒；本轮未新增付费评测、未跑全仓、未安装、未合并、未部署、未运行CI或创建tag，旧版服务未触碰。必要材料/候选审阅、版本/来源/权限围栏保持，完整Service恶意恢复证明等逐项负例未全部实跑。

保留最终 `round-19/validation.json` 和五份日志：`routing-native.log`、`clarification-native.log`、`clarification-fence-focused.log`、`topic-store.log`、`release-smoke.log`。SHA256见validation。旧Native/SG6中间日志及SG6旧候选目录在本报告与矩阵核对后按规则清理，原失败和历轮报告/矩阵结果保留，不将已清理路径作为现存证据。未写整体report.md，长期真实语义/性能目标仍未收敛。

## 第20轮证据清理说明

第20轮合并部署及最终脱敏证据归档并独立核对后，本轮5份原始/归档测试日志附件已按保留规则清理；正文中的原附件路径仅作历史出处，不再依赖文件存在。原测试结果、关键失败摘要与日志SHA256继续保留在本报告及 `round-19/validation.json`；该JSON的210源码绑定仍用于证明新部署包与已测包相同。最新部署终态、原生退出超时及接续证据见 `round-20.md` 和 `round-20/validation.json`。
