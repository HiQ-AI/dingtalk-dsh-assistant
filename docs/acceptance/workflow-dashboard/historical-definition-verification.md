# 工程历史定义独立验证

2026-10-13 独立检查结论：固定基线的一个真实 v25 工程定义可由当前 v26 实现恢复，摘要逐字相同，恢复过程持久化写入为 0。v26 注册覆盖未提供数据库入口、入口返回无数据库、入口返回授权目录三种情形，三项均通过。该结论限定为下述夹具与注册/恢复路径。

## 可复跑配方

从仓库根目录执行；不需要真实运行实例或数据库凭据：

```powershell
node docs/acceptance/workflow-dashboard/scripts/capture-v25-baseline.mjs
node docs/acceptance/workflow-dashboard/scripts/restore-v25-baseline.mjs
node docs/acceptance/workflow-dashboard/scripts/verify-v26-registry.mjs
```

`capture` 固定读取 Git commit `44646d2056375b32ebf2ed2f7812d946473f9722` 的 `workflow-engineering.js`、`task-workflow.js` 和 `execution-controller.js`，不随提交后的 HEAD 变化。三文件使用独立模块副本；其余依赖从当前安装环境导入。在 `docs/tmp/workflow-dashboard/` 创建独立源仓库、本地 bare remote 和 SQLite 控制账，以原工厂实际登记 v25，完成基线自恢复，再保存序列化配置与 record。Git 推送仅发生于该临时目录里的本地 bare remote。

`restore` 使用当前源码读取同一个 record，以 succeeded 历史运行形态恢复；夹具拒绝任何持久化命令。`verify-v26-registry` 仅写独立临时 SQLite 注册账，不执行业务节点或数据库请求。JSON、Git 仓库和数据库均留在 `docs/tmp/workflow-dashboard/`，不提交。

每次重新 capture 都生成新路径、提交和登记时间，因此摘要可以变化；判断条件是同一次 capture 的原摘要与当前恢复摘要完全一致。不能拿不同夹具实例的摘要互相比较。

## 本轮证据

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

早期恢复脚本未提供 `effect.list` 空集合，出现 `UNEXPECTED_QUERY:effect.list`；这是只读夹具缺项，补齐后通过。v26 输入映射首轮未提供 `prepare-generation` 依赖，出现读取 `requirement` 的 TypeError；补入与注册 record 相同的 requirement 后三种情形通过。两次均未改生产代码。

本文件不证明所有历史工程版本/配置组合，也不证明一次完整工程运行。未执行真实 DB 查询、业务节点、reset、reissue/rebuild、外部 PR、部署或钉钉消息；这几类证据不能由注册/恢复结果替代。浏览器 round 13/14 保持原证据，本验证未操作用户标签页。
