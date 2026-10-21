# 合入 main #238 的冲突修复

协调分支原 head `4be1236fdb3ac862d86d9422cd22ebe689fd6e54`，合入 main `61101c4`（#238 模型配置），使用 merge 保留两边历史，无 rebase/force。配置分支 worktree 未修改。

实际冲突仅两文件：

- `task-session-service.js` 初始化同时保留协调模型/mode 校验与 `taskModelConfig`。Owner 接收协调预评估上下文，同时读取 main 新增的 resident 统筹模型配置；执行模型和独立协调模型各沿原入口。
- `test/suite-map.json` 依现有生成器再生，两侧全部文件均保留，294文件逐一守恒，release/category未改变；native lane随文件增加按生成器轮转。

main 的模型配置、两行“推理深度”、默认 low、统一保存和分项回读 UI/API 原样保留。客户端、HTTP、task-model-config、task-resident-runtime 相对 main 无差异。#236 Owner无submit恢复仍保留原wake、session及持久退避预算，不能以会话结束替代业务完成。

验证使用隔离 profile `test/fixtures/native-profile/package.json`，不调用真实模型或渠道：

```powershell
$env:DSH_NATIVE_TEST_PROFILE='test/fixtures/native-profile/package.json'
node --test test/task-model-config.test.js test/client.test.js test/http.test.js test/task-model-reasoning-native.test.js test/independent-coordination-native.test.js test/coordination-reorder-native.test.js test/task-session-provider-native.test.js
```

首次63项：54通过、9失败、0跳过。失败均来自恢复测试自身注册的 Provider 未声明 low，新默认使其在进入stream前拒绝。只给该测试适配器补 low 能力声明（不声明 high），生产严格校验与原恢复断言未改变。独立审查确认根因和修复范围。

修复后仅重跑受影响的 `test/task-session-provider-native.test.js`：12通过、0失败、0跳过，涵盖同session/wake退避、空返回重启恢复、七次预算及非provider故障防循环。其余六文件51项已在首次通过，无后续源码修改，不重复机械运行。最终63项均有通过证据，历史54与复验12不累加。复验日志 `/workspace/coordination-final-evidence/merge-main-provider-regression.log`。

独立只读审查通过：service/task-session/store/native fixture自动合并保留两侧合同；映射两侧missing=0，release/category变化=0。`node scripts/test-suites.mjs check`、`git diff --check`通过。未重跑全量、真实模型、Chromium、生产验收或CI；此前真实模型结果属于修复前精确实测树，本合并树仅做上述受影响程序回归。不合并PR到main、不部署、不发版。
