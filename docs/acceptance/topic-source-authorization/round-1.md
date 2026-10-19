# 第一轮

Node 24.19.0，DSH_NATIVE_TEST_PROFILE 指向当前本机 web/package.json。新增 reopen 与三种话题历史定向用例实跑 4/4 通过，0 skipped：跨作者 task-reopen，原错误恢复仍同 task/session/decision，runSequence=2；第二次重试不增加 runSequence；跨作者 task-context 可执行；真实未准入消息仍报 SOURCE_VERSION_MISSING 且不发成功回复。

扩大到 task-topic-routing-native、task-session-human-native、topic-runtime 时发现 Web 入口也复用 applyTopicAction，非 web 过滤使该既有路径失败。修复为精确配置 webActorId 可接纳，内部来源仍拒绝；下一轮复跑。最初错误注入试图修改冻结 store.command，测试夹具失败，随后使用真实 SQLite store 的包装命令在写入前注入原错误并通过，不修改生产账。
