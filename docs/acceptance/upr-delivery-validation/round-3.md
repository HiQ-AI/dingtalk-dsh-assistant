# 打包单项复验

候选未变，单独运行 `node --test --test-name-pattern='actual npm tarball' test/task-session-package-native.test.js`，仍使用现有 native profile，保留原 30000ms 超时。

1/1 通过、无跳过，测试内完成打包、解压、原生任务运行与清理耗时约 26.1 秒。见 package-rerun.log。不删除前轮超时，也不把分次结果说成一次八项全绿。
