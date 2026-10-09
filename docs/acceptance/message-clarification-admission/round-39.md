# Round 39：精确 provider 传输失败沿现有暂态恢复

## 结论与边界

已实现并定向验证。仅原生本轮错误 code 为 TRANSPORT 且消息首行为 fetch failed 时，归类 EXECUTION_PROVIDER_TRANSIENT；沿现有退避与最多三次恢复，不新增恢复接口。鉴权错误、其他 TRANSPORT 消息、PI_AI_ERROR 下的 fetch failed 均不扩入。

旧 EXECUTION_PROVIDER_FAILED 可由现有只读原生回合取证、node.failure.reclassify CAS 路径重新分类。保留本轮身份、租约、输入摘要、无提交、drained、无副作用条件。普通 repair 不因此接纳 provider failed；inspectNodeRecovery 的窄 reclassifyProvider 标记仅由已检查的重分类分支传入。

## 现场诊断依据

execution-f3950ac25fdf73bec1288597a5a47b7915149fb8 当前回合 seq153 turn/end 的错误为 TRANSPORT，首行为 fetch failed；本轮此前有五次 engineering_repo_inspect，无提交。历史 seq79/90 的 PI_AI_ERROR overloaded 不作为当前回合依据。此处仅记录诊断，不宣称现场任务已恢复。

## 改动

- execution-session.js：精确 TRANSPORT 分类及旧 EXECUTION_PROVIDER_FAILED 的只读取证准入。
- execution-store-worker.js：现有重分类入口接纳该旧错误；普通恢复资格不扩大。
- workflow-service.js：既有恢复扫描纳入旧 EXECUTION_PROVIDER_FAILED，仍先原生取证。
- execution-session-native.test.js、execution-store.test.js：分类与 CAS 正反例复用原测试。

## 实跑证据

PowerShell 中 TEMP/TMP 指向工作树 docs/tmp/authorization-state-tests。

```powershell
node --test --test-name-pattern='本轮provider|旧provider失败只读重分类' test/execution-session-native.test.js
```

PASS 7/7。覆盖精确传输失败、错误 code/消息反例、当前原生身份/租约/输入摘要、历史错误不借用、已有提交拒绝。

```powershell
node --test --test-name-pattern='旧未提交错误受管重分类CAS|provider暂态恢复沿用退避' test/execution-store.test.js
```

PASS 17/17。两种旧错误分别验证 valid/revision/lease/digest/session/output/undrained/effect；原有重启后最多三次退避仍通过。

本轮五个代码与测试文件 git diff --check 通过。未提交、未部署、未写现场控制库；真实恢复由部署后的正式扫描另行回读。
