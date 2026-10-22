# 第二轮：实际统筹配置的摘要修复与最终核验

此前脚本的模型参数与真实统筹不同，因此读取原任务 request/header 及当前只读配置确认 `openai-codex / gpt-6-astra / low`，按该配置重新验证关键情境。补丁前的真实模型出现“正继续核对”“已纠正”，但同一决定只证明反馈接收且未消费。该轮工具结构通过，语义失败，完整反例仍在 [model-round-4.json](coordination/model-round-4.json)。

在 `packages/dingtalk-dsh-assistant/task-session.js:45` 只增加摘要事实边界：统筹已发出要求与执行已发生动作分开；只有 received/consumed 不能写成执行已经回到目标。运行指引及 README 同步，不新增调度状态或 Host 业务判断。

最终 `task-session.js` SHA256 为 `30156dfd98d6720b49cbdb1b76f162762de1dc7128d3736603cabf013746b1b0`。实际配置 **8/8** 场景的源码摘要与该候选一致，主代理独立阅读全部实际摘要、limitations 和反馈，确认首次偏离及时纠正、摘要不再超前、正常等待保留；全部决定从原生日志独立读回。四个偏离各向原执行反馈一次，其余四个合理等待没有重复提醒；无取消、替身、人工申请及工具错误。详见 [逐例说明](coordination/verification.md) 与 [原始模型结果](coordination/model-round-5.json)。

原生最终候选两组独立命令：

```powershell
$env:DSH_NATIVE_TEST_PROFILE='D:/dsh_home/profiles/web/package.json'
node --test test/task-session-progress-native.test.js
$env:DSH_NATIVE_TEST_PROFILE=(Resolve-Path test/fixtures/native-profile/package.json).Path
node --test test/task-session-progress-native.test.js
```

当前 Host `0.2.1-rc.2` 与仓库锁定 `0.2.1-alpha.2` 各 **5/5，0 跳过**，日志分别是 [当前 Host](coordination/native-final-tests.log)、[锁定 profile](coordination/native-locked-profile-tests.log)。同一组用例不叠加统计。主代理与子代理交接时各运行了一次同组复核，属于本轮重复验证，未扩大到全仓测试或改变运行实例。

技能最终 **21/21**、独立原反例复测、三个相关技能结构校验、七个文件摘要回读、相关 JavaScript 语法与 `git diff --check` 均通过。`goal.md` 初次检查因“当前子目标”混入说明被校验器拒绝，改为单一 SG ID 后检查通过；没有修改校验器绕过。

组合消息能力仍未完成。组合交付模型场景通过，仅证明统筹能拒绝“拆发附件字节正确即完成”的错误判断；没有获得真实组合协议或发送任何测试消息。上游问题稿仍仅本地准备。未部署插件，现有个人技能目录已更新；不能把本轮 PR、单次合成场景或本地浏览器结果等同于线上业务与群内呈现验收。
