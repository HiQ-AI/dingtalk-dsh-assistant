# R29：实际团队链完成，PTY 退出结果仍失败

后端冻结 SHA256 为 `fef786be61417bcaf2f6d42134bd5a30a80efdd284649e3a5a26da87fc0cc415`。48 项 adapter 合同通过，0 跳过；实际固定包原生任务与 Resident 健康测试 2/2 通过，保持原 30 秒限时。分别见本轮 `config-execution.md` 和 `../round-28/package-fixed-native.log`。

真实第三次集成 `docs/tmp/interactive-team-live-3/`：CLI `e1f5e86d-1610-4d94-896b-bc43347b9bda`，原生 team `session-52e70092`。calc/check 通过 `main` 报告 703，并完成队友间直接核对；原生 transcript 的 peer attachment 证实 Lead 实收。两个原生 shutdown_response 均批准，之后 ListAgents 不再显示队友，Host team.snapshot 仅剩 lead。

事件 134–139 为真实结构化提交、Host received 和 PostToolUse；140–142 为 Stop、再次 team.snapshot 只剩 lead、SessionEnd reason=prompt_input_exit。事件 143 的 PTY outcome 却只有 signal=null，exitCode 缺失。因此 adapter 正确返回 no_submission，本轮整体 FAIL，不能把提交或 SessionEnd 当退出 0；第二输入轮没有运行。

正在定位补丁 PTY 对真实 Claude 退出码的处理，保持退出 0 完成条件。普通 Node 三种 PTY 单测成功不能替代此真实 CLI 结果。wrapper 59100、CLI 14864 的退出及包修复由下一轮独立复核；不覆盖本轮源摘要和首错。

测试脚本自身另有可选 plan/activity 传 undefined 到生产 Store 的错误，已按生产 service 的条件展开方式修正。该错误使部分阶段报告被拒绝，模型继续完成了团队流程；不作为生产 callback 缺陷，也不重写原日志。
