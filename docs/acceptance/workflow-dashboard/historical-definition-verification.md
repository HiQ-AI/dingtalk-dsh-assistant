# 工程历史定义独立验证

2026-10-13 最终结论：合并 `origin/main@f1487e0` 后，按其真实发行合同字节登记的 v25 可由当前 v26 实现恢复，16 节点、摘要一致、持久化写入 0。原先在 Windows 全 CRLF 合同下生成的 446 基线仍报 `ENGINEERING_DEFINITION_DRIFT`；同一 record 的隔离字节对照已证明原因是上游 #165 恢复发行字节，原 record 和 expected 均未修改。v26 三种注册/恢复场景继续通过。不能将此表述为所有换行形态的 v25 均兼容。

## 可复跑配方

从仓库根目录验证最终发行基线；不需要真实运行实例或数据库凭据：

```powershell
node docs/acceptance/workflow-dashboard/scripts/capture-v25-baseline.mjs release
node docs/acceptance/workflow-dashboard/scripts/restore-v25-baseline.mjs release
```

`release` 模式固定读取 `f1487e05736774b377daecf29988b6807365df7a` 的 `workflow-engineering.js`、`task-workflow.js`、`execution-controller.js` 和 `engineering-output-contract.js`，包括最后一个文件的真实混合发行换行；不随 HEAD 变化。其他依赖从当前安装环境导入。在 `docs/tmp/workflow-dashboard/` 创建独立源仓库、本地 bare remote 和 SQLite 控制账，以原工厂实际登记 v25，完成基线自恢复，再保存序列化配置与 record。Git 推送仅发生于该临时目录里的本地 bare remote。发行基线写到独立 `v25-release-baseline.json`，不会覆盖旧 `v25-frozen-baseline.json`。

原 `initial`/无参数模式固定读取 446 的三个工厂文件，合同依赖来自当时检出环境。原夹具已在合并前生成并保留；当前不得重新 capture initial 来替换它。对保留夹具可执行：

```powershell
# 当前发行字节下预期失败，保留退出码 1 和原 expected。
node docs/acceptance/workflow-dashboard/scripts/restore-v25-baseline.mjs
# 同一 record、同一当前工厂，仅隔离合同副本的换行不同。
node docs/acceptance/workflow-dashboard/scripts/verify-v25-contract-bytes.mjs
node docs/acceptance/workflow-dashboard/scripts/verify-v26-registry.mjs
```

`restore` 使用当前源码读取同一个 record，以 succeeded 历史运行形态恢复；夹具拒绝任何持久化命令，PASS/FAIL 都写独立结果 JSON。`verify-v25-contract-bytes` 只在临时副本记录原 defineExecutionWorkflow 返回的摘要，保留生产比较逻辑和原 record，不跳过校验；两组只相差合同换行字节。`verify-v26-registry` 复用保留夹具的隔离仓库配置，仅写独立临时 SQLite 注册账，不执行业务节点或数据库请求。JSON、Git 仓库和数据库均留在 `docs/tmp/workflow-dashboard/`，不提交。

每次重新 capture 都生成新路径、提交和登记时间，因此摘要可以变化；判断条件是同一次 capture 的原摘要与当前恢复摘要完全一致。不能拿不同夹具实例的摘要互相比较。

## 合并前证据（保留）

- 基线 capture：PASS；v25，16 节点，原工厂自行恢复摘要一致。
- 当前恢复：2026-10-13T04:18:24.815Z，PASS；v25，16 节点，持久化写 0。
- 同一 record 的原摘要与当前摘要：`0151d7e841763872efd168261338c666a8f353d0766e5feb08208d68f4479dd8`。
- 原始结果：`docs/tmp/workflow-dashboard/v25-frozen-baseline.json`、`v25-current-restore.json`。
- v26 注册与恢复：2026-10-13T04:17:49.793Z，3/3 PASS；原始结果 `docs/tmp/workflow-dashboard/v26-registry-results.json`。

| v26 情形 | 注册及节点输入 | 当前源码重启重建 |
| --- | --- | --- |
| 不提供数据库回调 | 16 节点；方案节点只有 `engineering_repo_inspect`，无数据库 scope/catalog | 摘要一致；当前目录读取 0；持久化写 0 |
| 回调返回 null | 回调 1 次；16 节点；方案节点无数据库工具和 scope/catalog | 摘要一致；当前目录读取 0；持久化写 0 |
| 回调返回授权目录 | 回调 1 次；仅方案节点增加 `query_readonly_database`；scope/catalog 与冻结 record 相同 | 摘要一致；当前目录读取 0；持久化写 0；篡改已冻结 databaseIds 后以 `ENGINEERING_DEFINITION_DRIFT` 拒绝恢复 |

三种情形的实施节点都保持 version `11`，工具仍为 `engineering_repo_inspect` 与 `engineering_apply_edits`。

本轮读取的源码 SHA256：

| 文件（均位于 packages/dingtalk-dsh-assistant） | SHA256 |
| --- | --- |
| workflow-engineering.js | `0d8f026cbf03e6a5acaad35550aa5bcc7df9e8a27ca67eef98f1988df8368505` |
| task-workflow.js | `ad62e946eda60a9e15d5a082bd13ae93543d663758e577c6a0ac3963d6e72288` |
| execution-controller.js | `2ee5c09fc21b9f7d9394d7f28ed5db9e0909c955452f335bef4891ce8ee77b94` |

## 独立审查发现

1. 定义摘要包括节点 `mapInput/execute`、校验/修订回调的函数源码，以及 Owner 回调源码；闭包中的冻结数据需要显式进入 `rulesDigest`。直接扩写已有工厂或被序列化闭包的版本条件会污染 v25 历史摘要。当前实现把 v26 归一为 v25 建底座，再按冻结配置装饰方案节点，本夹具验证旧摘要未改变。
2. `build` 内归一并不能覆盖外围 admission、恢复及重执行版本判断。本轮检查到 repository read、local acceptance、delivery、reset 和 refresh 分支已增加 v26；reset 保留来源 v26。
3. 发现 `reissueTask` 原先硬编码 v22，会使 v26 方案节点触发 `developmentBranchAction=rebuild` 后丢失查询能力。已反馈实现代理；回读当前源码已改为来源 v26 保持 v26，其余仍走既有 v22。此处属于源码确认，实际 reissue/rebuild 验证由对应 runtime 专项承担。
4. v26 目录与 scope 纳入节点摘要，重启不调用当前目录回调；独立篡改范围的恢复测试证明摘要拒绝该变化。

## 尝试记录与边界

早期恢复脚本未提供 `effect.list` 空集合，出现 `UNEXPECTED_QUERY:effect.list`；这是只读夹具缺项，补齐后通过。v26 输入映射首轮未提供 `prepare-generation` 依赖，出现读取 `requirement` 的 TypeError；补入与注册 record 相同的 requirement 后三种情形通过。字节归因脚本首轮尝试用无 digest 的内存副本读取候选摘要，被现有恢复校验拒绝；随后改成仅观察原定义函数的返回值，不再改 record，完成归因。以上均未修改生产行为或旧 expected。

本文件不证明所有历史工程版本/配置组合，也不证明一次完整工程运行。未执行真实 DB 查询、业务节点、reset、reissue/rebuild、外部 PR、部署或钉钉消息；这几类证据不能由注册/恢复结果替代。浏览器 round 13/14 保持原证据；合并后浏览器结果为 round 18/19/20，本验证未操作用户标签页。

## 合并后的最终证据

1. 原 446 record：2026-10-13T05:29:09.287Z，FAIL，`ENGINEERING_DEFINITION_DRIFT`，写入 0；expected 仍为 `0151d7e841763872efd168261338c666a8f353d0766e5feb08208d68f4479dd8`。结果为 `docs/tmp/workflow-dashboard/v25-initial-restore-result.json`，原始 fixture 仍为 `v25-frozen-baseline.json`；合并前 `v25-current-restore.json` 的 PASS 未覆盖。
2. 同一 record 字节归因：2026-10-13T05:29:09.659Z，PASS。隔离合同为旧 53 CRLF / 0 LF 时，当前工厂返回原 expected 且严格恢复通过；仅换成上游 35 CRLF / 18 LF 时，严格恢复失败、候选摘要为 `ed9b5b11a248f731ee704232bfcd3f98cd78f68f912f4b46e83b2ccf269e806d`。原 fixture 前后逐字节一致，写入均为 0。结果为 `docs/tmp/workflow-dashboard/v25-contract-byte-attribution.json`。
3. 新 f148 发行基线：真实 v25 登记、自恢复与当前源码恢复均 PASS；当前恢复时间 2026-10-13T05:29:09.297Z。16 节点、写入 0，原/新摘要均为 `fa635cc3c5a79edd88665656331dba145be6945c6d6fa1b233cef0023f0feb1f`。新 fixture 为 `docs/tmp/workflow-dashboard/v25-release-baseline.json`，当前恢复结果为 `v25-release-restore-result.json`。这是新增基线，不修订原 446 的失败。
4. v26 注册/恢复：2026-10-13T04:39:42.318Z，omitted/null/database 三种情形 3/3 PASS；16 节点、冻结输入/工具边界、重启不读当前目录、scope 篡改拒绝均与合并前相同。结果为 `docs/tmp/workflow-dashboard/v26-registry-results.json`。

最终当前源码 SHA256：

| 文件（均位于 packages/dingtalk-dsh-assistant） | SHA256 |
| --- | --- |
| workflow-engineering.js | `0d8f026cbf03e6a5acaad35550aa5bcc7df9e8a27ca67eef98f1988df8368505` |
| task-workflow.js | `ad62e946eda60a9e15d5a082bd13ae93543d663758e577c6a0ac3963d6e72288` |
| execution-controller.js | `bb5efb867df388ba521219af2e24e81acc4a1bc1c85ac22f0f609e4c9c4218f5` |
| engineering-output-contract.js | `8e82c88c2eb226dc1ed880f1f399f60a29f8d51c1929405c879aecacee34561a` |

旧全 CRLF 合同 SHA256 为 `996b5fe30532a4dbcb686b589f7c3c4073d078f8e13a2e21673bc5fb23589a43`。与当前发行合同忽略行尾的语义 diff 为空；合同验证函数原文进入 `rulesDigest`，因此换行足以改变摘要。保持发行字节是上游 #165 的明确修复，本特性未另加旧全 CRLF 兼容或自动迁移。
