# 第3轮：登记与执行进度分离

最终统筹源SHA256：`b7d5b224f839ef71da2882a9bb5cb0b6a5a7386b26bb2dcc80cb2a39cef6d719`。模型、profile、隔离策略及生产Store与第2轮相同。原始记录在 `docs/tmp/task-collaboration-model-round-3/`，实际调用见 [model-results.json](round-3/model-results.json)。

- independent-ready：seq16、21登记两份独立委派，seq26才wait。summary为已分别安排，limitations明确“两项当前均待启动，尚无改动或验证结果可供验收”。结构与人工语义PASS。
- complex-self-claim：seq16–31读原始结果，seq36安排固定候选独立只读核验，seq41提交wait。summary为“已安排对冻结候选做独立只读验收”，limitations为“独立验收已登记，等待结果”；三类验收、反例与禁止部署/发送均保留。结构与人工语义PASS。

主会话及独立审阅者均读取完整回执和决定后确认。最终有效覆盖为第2轮五例加第3轮两例，不冒称最终提示词七例全跑。第2轮原进度事实性失败保留。模型样本不提供统计可靠性或真实业务完成保证。

最终源码 `pnpm test:release-smoke` 14/14、0失败0跳过；实际tarball提取后执行及resident启动验证通过，见 `round-3/release-smoke.log`。源码与浏览器验证不等于已安装现场，未运行CI。

复验命令（使用当前受信环境路径与代理）：

```powershell
$env:DSH_NATIVE_TEST_PROFILE = '<完整原生profile>/package.json'
node docs/acceptance/task-collaboration-quality/scripts/evaluate-model.mjs --check
node docs/acceptance/task-collaboration-quality/scripts/evaluate-model.mjs docs/tmp/<新目录> <Connect入口> gpt-6-astra low <代理URL> independent-ready complex-self-claim
```

每次新目录，不覆盖首错；人工对照receipt/nativeTrace审阅，自动structuralPass不等于语义PASS。
