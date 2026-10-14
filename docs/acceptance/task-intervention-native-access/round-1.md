# 定向测试

2026-10-14，Node 24，原生测试 profile 为 DSH Web 已安装 profile。`docs/tmp/intervention-targeted-tests.log`：189 tests / 189 pass / 0 fail / 0 cancelled / 0 skipped，耗时23271ms。

实际命令：

```powershell
$env:DSH_NATIVE_TEST_PROFILE='D:/dsh_home/profiles/web/package.json'
node --test test/dynamic-task-store.test.js test/task-session-human-native.test.js test/task-filesystem-boundary-native.test.js test/group-reply-format.test.js test/task-notification-readback.test.js test/task-notification-delivery.test.js test/dws-adapter.test.js test/dws-bridge.test.js test/task-message-projections.test.js test/task-session-http-integration.test.js test/task-session-skills-native.test.js
```

- 原生引用及@保持，正文只去除与受信原消息相同的前置引文；其他证据引文保留。
- operator申请进入Web和登录人私聊，不进入业务群发件箱；requester业务问题仍可在原群答复。
- 私聊引用必须匹配原通知、会话、真实作者及当前需求/控制版本；重复监听/历史补拉不再唤醒。
- 原生read读取原任务日志和其他已授权路径；缺文件及目录错误继续纠正，不产生未知写。
- 原生终端运行gh --version成功；已存在unknown及旧host-native-operation锁仍保留，未阻断新原生调用。

补充宽范围测试 `intervention-final-tests.log`：210 tests / 209 pass / 0 fail / 1 cancelled。唯一取消是现有上下文压缩测试第32项的30秒期限。单独重跑及未修改origin/main快照均复现超时，分别记录于`intervention-context-isolated.log`、`intervention-baseline-context.log`。未修改其期限，不将宽范围测试宣称全绿。以上定向测试包含正确文件名的原生skills五项，均通过。

首次验证暴露并修正：业务问题fixture缺少requester分类、历史补拉误走原始event转换、原生pwsh缺必填description。修正后按完整定向集合重跑取得上述结果。
