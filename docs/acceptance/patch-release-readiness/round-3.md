# 第三轮：正式Tag检查未通过

PR205合并main b63d652，v2.0.1注释Tag解引用同提交。Release run39214657717完整测试3219项：3214通过、1失败、0取消、4既有跳过，843.2秒。npm发布及GitHub Release创建步骤未执行。

唯一失败为Provider restart=true，在10秒内等待task completed超时，非业务断言不符。测试把定时恢复准入与后续模型/引用读取/执行混入同一10秒窗口。改为原10秒内确认原执行inputVersion2的恢复准入，再await原生whenIdle并明确断言task completed，保留同execution/session、唯一operation、只写一次等全部检查；原测试总时限不变。定向复核进行中。

Tag已公开但尚未发行包；不能无授权改写远端Tag。修复合入并完成本地验证后，须按仓库force-push规定向用户申请仅移动此未发布标签，且以旧Tag对象作lease约束；否则保持未发布状态。旧Tag对象6da32e1891b37870858c6a472372b400b42e4cd2，原main b63d652c54ba653c893741cbf5a7c8025d5d5ea9。原CI失败日志docs/tmp/release-2.0.1-ci-failed.log保留。

准入检查调整后，Provider恢复完整文件8/8通过、0取消/跳过，111.7秒。原重启true用例10.1秒，false20.6秒。尚未移动Tag。
