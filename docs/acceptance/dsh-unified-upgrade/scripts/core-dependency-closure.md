# 原生 Web core 依赖闭包来源

正式 profile 与 alpha2 的 `dsh-app-boot.initProfile` 均采用 `nodeLinker: hoisted`、`autoInstallPeers: false`。此前隔离 profile 只保留 packages，意外采用 pnpm 默认策略，自动 peer 安装掩盖正式缺失；正确修复保留原生策略，显式声明所需依赖。

本轮 32 个 direct core 分为：原5项宿主/基础bundle/Cordis/Loader + 25项required-peer依赖闭包 + 2项显式pin的原生CLI dependencies。25项是关闭autoPeers后依赖拥有图不再覆盖的required-peer；include/timer已经是CLI原生dependency，不把它们谎称缺失required-peer。保留它们的显式精确声明，与已实际冷验证的32项候选完全一致。

- `@deepseek-ai/cordis-plugin-include`：原生 `@deepseek-ai/dsh@0.2.1-alpha.2` 的 dependencies 声明 `~1.0.10-alpha.1`；本轮选定 `1.0.10-alpha.1`。
- `@deepseek-ai/cordis-plugin-timer`：相同父包 dependencies 声明 `~1.1.7-alpha.1`；本轮选定 `1.1.7-alpha.1`。
- 父 manifest 实读 SHA256：`f33d958d5b858747dd6c281ffecbf3b4b5cdee5b3ee02817e9339879a6d71b61`；绝对realpath由 `docs/tmp/core-peer-closure.json` 每条reasons记录，gate必须读取该文件校验，不只信任本说明。
- closure `extraDirect` 为27项；139条reasons包含137条requiredpeer和2条dependency。`kind` 分类必须严格保留，`optional` 均明确为false；记录actualName/actualVersion及manifest绝对路径和SHA。
- 本次 closure SHA256：`898e03da08c3d07663add99aef280b45a7e03d680873fea85f2b8452989da3bb`。`candidate-repair-summary.json` 已更新同一closure来源SHA。

独立 candidate-repair 原样复制正式 pnpm-workspace，从空 node_modules 安装，原生 CLI、Codex11模型prepare/dispose、四preset实际mount、三Convergent实例、client graph与认证headless UI均通过。认证UI只证明代码/render兼容，仍明确采用隔离GET/CORS桥接及synthetic task；正式3080原生UI需部署后另验。

上游source、正式profile、原冻结proposal/helper均未修改。closure及summary是新只读来源材料，须由部署continuation在独立readback后冻结；不得通过放宽校验或开启autoInstallPeers绕过缺失。
