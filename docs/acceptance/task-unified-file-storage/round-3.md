# 第三轮：全量回归首次失败

`pnpm test` 首轮：1685 tests，1680 pass，3 fail，2 skip，0 cancelled。完整原始输出留在私有 docs/tmp/task-unified-file-storage/full-test.log，未覆盖。

三个失败均在 investigation-continuation 的既有 fixture：缺少当前契约必填 acceptanceItems/findings/openItems/criterionReviews。独立定向复现3/3失败；修正仅测试输入，原延续和授权断言保留，定向复跑3/3通过。此轮不写全绿结论。

两个跳过分别为没有 HOST_BACKGROUND_TEST_JAR，以及 Windows 创建文件 symlink 报 EPERM；后者既有 junction 反例实际运行通过，不能宣称文件 symlink 已验证。
