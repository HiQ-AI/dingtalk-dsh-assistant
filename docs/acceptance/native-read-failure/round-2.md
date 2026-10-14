# 第二轮

- 增加工具同名覆盖和显式写效果的负例，保存取消及原效果类别；运行五个相关测试文件的定向用例：9/9 PASS，无跳过，见 round-2.log。
- 包运行验收：`node --test test/task-session-package-native.test.js`，2/2 PASS；实际 tarball 解包并启动任务与 Resident 健康路径，见 package-test.log。
- 未把所有工具错误改为 failed。任意写操作先产生效果后抛错仍保留 unknown；既有 shell/job 恢复规则保持。
