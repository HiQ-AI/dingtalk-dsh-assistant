# 第二轮：最终候选验证

完成日期：2026-10-23（本地时间）。

本轮最终模型采样保存在 `model-candidate-3.json`。此前 `model-candidate-2.json` 连接层 TRANSPORT 失败，零工具、零决定，没有产生行为样本；单独保留，不计 PASS。

## 固定候选与实际命令

模型：`openai-codex / gpt-6-astra / low`。任务、会话及文档目录改为中性编号，预期只在评测器侧。所有业务证据均为合成材料；模型可读取当前合成文档与原生内容引用，不能访问业务系统、改文件或发送消息。

```powershell
$env:DSH_NATIVE_TEST_PROFILE = 'D:/dsh_home/profiles/web/package.json'
node docs/acceptance/task-progress-steering/scripts/evaluate-model.mjs docs/tmp/config-inquiry-baseline/candidate-3 D:/dsh_home/profiles/web/node_modules/dsh-codex-connect/lib/index.js gpt-6-astra low http://127.0.0.1:10808 config-support-only-reader-answer config-constant-result-answer config-constant-running-detour config-other-version-result-gap config-runtime-reader-result-gap config-explicit-full-investigation
```

采样时 SHA256：

```text
task-session.js
ff3bf66c59926d7b867937afc62b83144174e22347b6e96579d539183794355b
task-progress-correction-scenarios.js
165d71551738d5e958534b9a3043511a43e9fd2cea09ce084ab63b17a45b59d5
evaluate-model.mjs
138d4bcbd3955f97545c67c32a4acf2f4c8a5cd90e12b5e2af7128fa1bb1fe52
```

## 逐例语义审阅

根代理从结果文件独立读取所有 summary、evidence、limitations 以及纠偏/续办全文，不只检查动作名称或关键词。

| 场景 | 实际决定及原因 | 结果 |
| --- | --- | --- |
| 仅问指定提交支持性，存在 getenv | complete；直接回答支持、默认 INFO，未把 handler/现场未知变成调查前置条件。 | PASS |
| 当前版本固定 INFO，无外部入口，结果已齐 | complete；直接说明 Deployment 设置 DEBUG 和重启均无效；没有多余人工申请或委派。 | PASS |
| 同样充分证据但执行仍计划多查现场 | 原 executionId 的 feedback + wait；停止不影响结论的补查，等待原执行正式结果，明确纠偏尚未消费/落实。 | PASS |
| 只有历史分支常量，当前生产未绑定 | 原 executionId 续办 + wait；自行补 digest/provenance 与实际读取链，不把历史结论当生产事实。 | PASS |
| 真正读取环境变量但 handler/覆盖未知 | 原 executionId 续办 + wait；承认支持配置，只补影响原因判断的过滤与加载证据，不要求用户代查。 | PASS |
| 用户明确要求完整现场调查 | wait；保留 Pod 注入、启动时间、handler 与日志范围，不以已有常量结论缩小验收。 | PASS |

六例均无工具错误、无多余人工申请、取消或替身执行，决定从原生持久化再次读回。合成调用的 received/queued 不被表述为实际落实或已启动。

独立审阅要求再加强“读取在决定之前”的证明：应关联成功 read 返回，而不只比较 tool/call 顺序。采样后只调整这一验收断言，不改变模型材料或生产提示词；对本轮持久原生日志重新核验成功返回顺序，证据与最终评测器摘要见 `native-document-order.json`。未因此重跑模型。

## 本地回归与技能

最终代码使用锁定 native profile 执行：

```powershell
$env:DSH_NATIVE_TEST_PROFILE = (Resolve-Path test/fixtures/native-profile/package.json).Path
node --test test/task-session-progress-native.test.js
```

`native-tests.txt`：6 tests / 6 pass / 0 fail / 0 skipped，耗时 25979.031ms。覆盖十分钟窗口、当前执行文档、多轮职责、人工等待与原执行纠偏；未跑全量。首次偶发 active/completed 断言失败的根因仍未收敛，见第一轮，不因最终通过删除失败。

运行技能四例试用及最终 SHA256 在 `skill-review.md`，结构校验通过。语法检查覆盖 task-session、场景与评测脚本，最终 diff 检查在提交前执行。

## 适用边界

技能文件已改到实际运行目录，已有长会话是否重读未验证。插件提示词属于本 PR 候选，尚未合并或部署。原任务未重放、生产未访问、钉钉未发送；评测没有证明随机模型今后每次都做出正确判断。旧模型场景集合未全量重跑；本轮仅对六个配置场景作行为声明。
