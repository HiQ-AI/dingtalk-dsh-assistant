# 第 7 轮：原生失败定向修复复验

日期：2026-11-03

## 结论

第6轮新发现的10个失败变体，在保留业务断言、循环界限与各自原超时的前提下定点适配测试脚本；本轮10/10通过、0失败/skip/取消。它们不覆盖第6轮失败，也不消除独立的固定摘要历史合同FAIL。没有修改产品源码，脚本模型回归不证明真实模型语义或持续重提旧版本时无饥饿。

## 根因与修复

- 旧自定义route缺少active合同要求的目标reason及必要候选对照，实际返回 `topic_route_audit_reason_required`；按已见真实候选补具体理由，不在通用Host为模型结果静默注入。
- 路由角色不注入回复指导，decision及Task角色才注入；原回复scope断言限于实际包含该合同的非route阶段。两处业务提示按原route/decision现行语句分别断言，保留不唤醒、业务终态和通知检查；相关产品提示文件本轮未改。
- Web旧脚本忽略真实 `topic-stale` 结果继续提交旧revision，在业务超时后连带cleanup超时；测试模型以真实工具结果的requestId+revision识别过期旧轮，不对固定revision特判，保留rounds<30等原界限及图片、原Task、来源版本、无重复副作用断言。

D独立对照精确c80基线与当前三测试文件，未发现可证实的既有业务/循环断言删除、超时增加、固定revision特判或旧revision误吞新版；Lead独立核查其三个Git blob与当前一致。静态审查不能单独证明运行终态。

## 真实运行与版本绑定

两个命令顺序运行，均设置 `DSH_NATIVE_TEST_PROFILE=test/fixtures/native-profile/package.json`：

```powershell
node --test --test-reporter=tap --test-name-pattern='普通回复显式多收件人贯穿|native task service preserves Topic routing|native Topic handoff keeps|business notices 423|scripted native aggregation keeps|native Topic context accepts a requirement' test/task-topic-routing-native.test.js
node --test --test-reporter=tap --test-name-pattern='Web maintenance preserves an unsubmitted Topic input|web acceptance reuses existing topic' test/task-web-topic-reuse-native.test.js
```

- `round-7/topic.tap`：7项7通过、0失败/skip/取消；SHA256 `6b8aaeb478bdf23d7d38855db2232174630492ec964415769aa7a758cdf03cf3`。
- `round-7/web.tap`：3项3通过、0失败/skip/取消；cleanup分别39/196/181ms，均aborted=false；SHA256 `c3e0be71b7f91ed07a655cfff19d6d66c5f0ede7c3dc6d077e77b123ca236eac`。
- `round-7/binding-before.json`、`binding-after.json`：207个产品源码、测试及共享fixture的SHA256前后一致；Lead独立核全部207项当前文件仍一致。topic测试SHA256 `85b227885eea824d3b6b3de8bf91e1b5804bb2faf0612b70b8503ca0e7469718`，web测试SHA256 `865676387f7b6d11151c24e6e0766bc1c1b8f7c9e1705c7e32817f5183948d3c`。
- 测试映射本轮再次检查：`node scripts/test-suites.mjs check` → verified 341 files、historical 3、deleted 0。原guard三例与原环境skip三例通过见第6轮；核心450通过与同基线摘要1失败见第5轮，不重复相加重叠测试。

## 边界

120场景脚本化离线合同和真实Host执行结果见第6轮；真实模型质量、独立人工金标、真实角色内大候选/metadata续读E2E、真实钉钉、部署及CI均未验证。本轮没有付费调用、正式数据、外发或部署。固定摘要失败在c80基线存在，保持FAIL与原断言，不声称总体全绿。

## 附件保留说明

本轮报告中的原始中间附件已按保留规则清理，不另行备份或转移归档；原轮次结果及失败不变。最终必要证据集中保留于 `round-7/final-validation.json`：含各批命令、执行时/当前源码SHA、嵌套测试记录与失败细节、原日志SHA、全部104/16评估观测和前后绑定。第7轮两份最终原生TAP仍保留。汇总已独立核对后才清理原附件，不能将新汇总当作重新执行测试。
