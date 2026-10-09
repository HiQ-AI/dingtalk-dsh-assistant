# 第61轮：SG18同代候选增量编辑身份

## 结论与真实证据
原事件42790正式candidate-in-place修复保留同nodeRunId。旧edit成功输入8303…，新apply输入a297…；仅按node/action生成effect ID造成DELIVERY_IDENTITY_CONFLICT。只读原生query对现场原审计返回eligible=true，新效果e972…关联旧d5dde…，未写现场。spec为docs/spec/candidate-incremental-edit-identity.md。

仅改execution-delivery.js/execution-effects.js：控制账导出并在effect.prepare事务重验正式修复审计；新身份绑定新input及原成功效果，原dispatch身份/来源/维护/lease/授权校验保留。首次编辑、同输入重投不变；没有schema或冻结workflow factory变更。新的增量prepared不得重放旧补丁，同路径必须以旧目标哈希作新基线。历史效果始终保留。

## 实跑
- `node --test test/execution-delivery.test.js test/execution-effects.test.js`：69/69 PASS，12517.7ms。docs/tmp/incremental-edit-full.log。
- 在上述全文件之后追加第二次合法修复测试：`node --test --test-name-pattern '第二次合法' test/execution-delivery.test.js`：1/1 PASS。docs/tmp/incremental-edit-second-repair.log。证明新审计关联前一次增量效果、第三次文件内容与稳定重投身份；未把新增例算入此前69例。
- 新增前7例定向7/7 PASS：docs/tmp/incremental-edit-tests.log。真实managed-edit文件适配器执行同路径增量一次；并发/重投、缺修复、伪Task修复、unknown、外部动作、旧补丁重放、无审计直接effect.prepare、同旧input异内容及历史读取覆盖。
- 原账native SQLite backup到docs/tmp隔离目录，仅复制涉及的8个已编辑文件和1个新增修改目标。`node docs/tmp/test-sg18-incremental-snapshot.mjs`真实原node/run/generation/input，经原生run.recover→node.claim→新网关→真实managed-edit（目录映射只指隔离副本）→重复回读：新增edit执行1次，原8文件保留，新1文件修改，原业务工作区前后全部SHA一致。proof：docs/tmp/sg18-incremental-snapshot-proof.json，日志sg18-incremental-snapshot.log；noBusinessWrites=true。

## 失败与修正记录
初轮历史夹具只设置drained未给drain证据，原生STORE_INVARIANT_FAILED正确拒绝；补夹具证据后unknown反例把succeeded效果改unknown但遗漏resource hold，原生effect_resource_invariant正确拒绝。补齐unknown对应hold后7例全过，不修改产品资源锁规则。该日志同路径重跑已覆盖，不能声称首轮全绿或仍保有初轮日志。隔离原账首轮instanceId误用测试名被STORE_INSTANCE_MISMATCH拒绝，改为读取原账实例身份后通过；未放宽实例验证。

## 现场恢复边界
service不会自动重试DELIVERY错误。既有受信controller.recover已由隔离原账实际验证可原Run恢复；主线程部署后精确读取当前身份及正式审计，再沿该入口恢复，禁止手改库。此轮不部署、不改业务代码；通过的是插件恢复/真实文件效果链，不表示原Task业务已经完成。

现场闭环（4afb包）：原gen4 apply-changes lease3 succeeded，新edit-e972 succeeded且effect.started恰1，旧edit.started仍1，旧8文件逐SHA保持，增量1文件；原Run已进入verify-candidate lease2。独立证明 sg18-v2-real-increment-proof.json 与 sg20-v2-dispatch-readback.json。只证明原候选增量恢复，不表示完整导入导出FR已交付；检查4尚未绑定。
