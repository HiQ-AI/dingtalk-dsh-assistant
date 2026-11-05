# 第 14 轮：隔离首次回复 Native 回归（阶段记录）

日期：2026-11-05

## 结论与范围

本轮只复核已实现代码上的首次回复 history 与 isolation Native 定向测试。History 5/5 通过；Native 在工作树 profile 下首跑于 prepare 阶段因缺少 `@deepseek-ai/dsh-base` 失败，未进入业务；切换到已有 web profile 后，单独重跑 Native 文件为 3/3 PASS、0 fail/skip、exit 0。首跑环境失败保留，不计作产品业务失败，也不隐藏。

本回执仅绑定当前 coordinator 与所列 runtime/decision/helper/test blob。B 门禁合同尚未落盘，尚无最终联合门禁。本轮不代表五例真实模型、真实 Owner、钉钉送达或最终冻结回归通过；不修改 round-13 结论。

## 执行记录

| 阶段 | 命令范围 | profile | 结果 | 业务阶段 |
| --- | --- | --- | --- | --- |
| 首跑 | `test/first-reply-history.test.js` 与 `test/first-reply-isolation-native.test.js` | `.dsh/profiles/web/package.json` | History 5/5 PASS；Native 3/3 在 prepare 失败 | Native 未进入业务，profile 缺 `@deepseek-ai/dsh-base` |
| 定向重跑 | `test/first-reply-isolation-native.test.js` | `D:/dsh_home/profiles/web/package.json` | 3/3 PASS、0 fail/skip、exit 0 | 业务与 cleanup 完成 |

执行命令：

```powershell
$env:DSH_NATIVE_TEST_PROFILE='.dsh/profiles/web/package.json'
node --test test/first-reply-history.test.js test/first-reply-isolation-native.test.js
```

```powershell
$env:DSH_NATIVE_TEST_PROFILE='D:/dsh_home/profiles/web/package.json'
node --test test/first-reply-isolation-native.test.js
```

C 提供的完整输出为其私有任务结果 `btrc2ghjv.output` 与 `bohwi7kvl.output`；本报告不复制原始输出。首跑和重跑均未调用真实模型、真实钉钉或真实 Owner。

## 复验绑定

C 报告两次测试的相关文件 before/after Git blob 一致。另独立核对当前工作树 Git blob 与该清单相同：

| 文件 | Git blob |
| --- | --- |
| `packages/dingtalk-dsh-assistant/topic-runtime.js` | `4a7a76b1d3db125d8ad5fb7ae2ff5febd9bd353e` |
| `packages/dingtalk-dsh-assistant/task-topic-coordinator.js` | `ba9ff8d444261acb07f7db559f5b9c389013a454` |
| `packages/dingtalk-dsh-assistant/decision.js` | `7b778ba4dac5a52957e3f030557dbe31fc1e15de` |
| `docs/acceptance/topic-routing-quality/scripts/first-reply-history.mjs` | `731d3959c41a5fadf67658661e2c0b1044d89b48` |
| `docs/acceptance/topic-routing-quality/scripts/first-reply-isolation.mjs` | `91214caa6197b7988272ba29213353f4406e9a9f` |
| `docs/acceptance/topic-routing-quality/scripts/first-reply-bounded.mjs` | `8e30bdd48f9569d280ff6946e588bd006f1b3579` |
| `test/first-reply-history.test.js` | `f58447bf5a71d7fc205f2547693f272651d41565` |
| `test/first-reply-isolation-native.test.js` | `08746380dc0ace914f2b39d87422dac03ded433d` |
| `test/fixtures/task-session-native-host.js` | `5f804d55c45ec3847773838990e0b7f8ef4696b8` |

## 相关核心回归补充

另有当前工作树五文件定向回归：`test/topic-runtime.test.js`、`test/decision-payload.test.js`、`test/coordination-sessions.test.js`、`test/group-decision-contract.test.js`、`test/topic-role-context.test.js`，宿主回执为 237/237 PASS、0 fail/cancel/skip。该回执仅来自会话工具输出，未另存 TAP；执行前后源码与测试 blob 一致：

| 文件 | Git blob |
| --- | --- |
| `packages/dingtalk-dsh-assistant/decision.js` | `7b778ba4dac5a52957e3f030557dbe31fc1e15de` |
| `packages/dingtalk-dsh-assistant/topic-runtime.js` | `4a7a76b1d3db125d8ad5fb7ae2ff5febd9bd353e` |
| `packages/dingtalk-dsh-assistant/coordination-sessions.js` | `d23100a6c55abfb54c2092ec78e898046dcdb217` |
| `packages/dingtalk-dsh-assistant/task-topic-coordinator.js` | `ba9ff8d444261acb07f7db559f5b9c389013a454` |
| `packages/dingtalk-dsh-assistant/topic-facts.js` | `7d8b87e62157afde425a1a954228ecd8cd5145b4` |
| `packages/dingtalk-dsh-assistant/topic-model.js` | `653bfc340620a778ee44c1285f47520b6532a3a9` |
| `packages/dingtalk-dsh-assistant/store.js` | `40f60a57bfebceca6748c5f2f59d838aa94a8bc7` |
| `test/topic-runtime.test.js` | `7e8b32bd92590184fc42566419e66fe9a14d497e` |
| `test/decision-payload.test.js` | `3a0b0751911b407d0d4269e232b104c0d6333aa8` |
| `test/coordination-sessions.test.js` | `4cb7e7563a37f68afe332f16d1a76a1c0f7f2cb2` |
| `test/group-decision-contract.test.js` | `51758f10b70177f108f8182ef13874a72874bcf2` |
| `test/topic-role-context.test.js` | `2da59d7942d70cbe74464587dc88ceda4cdda6a7` |

C 另有 fact 定向 2/2 回执。该 237 项结果不覆盖随后 B 门禁改动，也不改写 round-13 的模型/审阅结论。

## 测试映射补充

Lead 另已完成测试映射生成器的 check：343 个登记文件各一次，historical=3、deleted=0、diff-check 通过；新增变更包括 `test/first-reply-history.test.js` 的稳定资源身份 helper 发布导入，以及相关资源登记。当前 `test/suite-map.json` 工作树 diff 同时显示多项 native-0/native-1 lane 重排；本轮不替 Lead 解释该生成结果，也不把映射 check 等同业务验收通过。

## 覆盖边界

隔离 Native 3 项覆盖禁用文件/执行工具与业务隔离、显式适配器、规范任务动作与隔离通知入账。仅证明这些定向 Native 用例在已有 profile 下通过；不等同最终 B 门禁、跨文件冻结回归、模型语义/性能或 round-13 780/783 candidate 修后复验。后续门禁与模型验证应另行登记，不覆盖本轮首跑失败或 round-13 结论。
