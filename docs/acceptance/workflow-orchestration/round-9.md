# 第 9 轮：全仓首轮，未通过

执行 `node --test --test-reporter=spec`，原始输出见 round-9-full-tests.txt。运行中发现 fake LLM 仍提交旧字符串协议，以及 Runtime 夹具没有模拟叶子步骤结束；旧进程在修复前仍持有等待状态，主动终止，不能给通过率。

后续修复 fake LLM 使用 Host prepare/register 和 v2 审阅回执；Runtime 夹具增加真实工具步骤 begin/finish，保留显式 idle 延迟。独立 Runtime 完整验证 147/147 通过，随后又增加 Goal 耗尽及历史无通知意图反例，全仓最终结果另轮记录。

反证审阅同时修复：依赖闭包失效、跨版本证据保留链、未引用证据夹带、多操作对账身份绕过、通知临界区版本复核与二次存储故障。未把这些问题隐藏为测试不稳定。
