# Round 47：派生输入 Stage 引用同步与历史对账

## 根因

现场83当前Stage.requirement_ref仍指gen1输入815f87cc，Run当前gen4指38569545；只读正式事件表证明run.create gen1，input.apply gen2/3/4，同Task/Run/workflow，三条输入均applied。因此node.failure.reclassify的inspectNodeRecovery被task-plan-not-current拒绝。正式分类artifact已落，排除未扫描/原生取证失败。

## 修复边界

execution-store-worker input.apply同事务维护当前绑定Stage引用。历史仅在既有重分类事务中通过正式逐代输入链对账，记录task.stage.requirement.reconciled事件；保留同源检查、计划当前性、来源、维护、租约、无副作用门禁，任何后续拒绝整事务回滚。未新增接口，未写现场库，未提交、打包或部署。

## 验证

```powershell
node --test --test-name-pattern='派生输入Stage|输入来源去重|旧未提交错误受管重分类CAS' test/execution-store.test.js
```

24/24 PASS（14.38秒）。首次测试plan-drift夹具使用非法planReq0，worker启动不变量正确拒绝；改为合法req2/planReq1漂移后通过。

再将新增夹具对齐真实三次input.apply→generation4，并单跑：

```powershell
node --test --test-name-pattern='派生输入Stage' test/execution-store.test.js
```

7/7 PASS（2.65秒）：当前同步、历史恢复、缺事件、任意外来Stage引用、未应用输入、需求版本漂移、命令租约漂移。后两项证明已进行的Stage对账随恢复拒绝一起回滚；重复合法命令走原receipt幂等。旧source去重/节点排空/输入CAS与16条旧失败重分类反例保持通过。

只读脚本docs/tmp/inspect-stage-lineage.mjs回读现场四代链，无现场动作。业务恢复仍需部署后正式扫描验证。

## 同因追加验证

历史任务继续接纳新输入也可能遇到Stage旧引用；input.apply在原revision CAS后复用同一严格历史链对账，再同步新引用。新增历史gen4漂移→新输入gen5成功和缺正式事件→整事务拒绝两例。

```powershell
node --test --test-name-pattern='派生输入Stage|输入来源去重' test/execution-store.test.js
```

最终10/10 PASS（6.52秒），含9例Stage当前/历史/反例及原输入CAS用例。代码已冻结；未提交/打包/部署。

## checkpoint 同因入口

checkpoint原先未比较Stage与Run需求引用，因而不会在这一步直接拒绝，但会把旧Stage引用携带到新workflow摘要，造成后续恢复继续失败。现有checkpoint事务读取当前Stage前复用同一严格派生链对账，无新接口或放宽；非法链在切换workflow前拒绝。

```powershell
node --test --test-name-pattern='工程检查checkpoint保留同代成功前缀|派生输入Stage' test/execution-store.test.js
```

追加真实已应用输入导致历史Stage漂移后checkpoint成功、缺input.apply事件则拒绝两例；同Task/Run/generation和已成功前缀保持，Stage最终引用等于Run。全部18/18 PASS。
