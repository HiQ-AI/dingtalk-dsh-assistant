# 第 6 轮：报告恢复与看板断言

执行 `node --test --test-reporter=spec test/task-reports.test.js test/observer-client.test.js`，23 项中 22 通过、1 失败。

报告完成已提交而回执未结算的恢复反例通过：仅相同 submissionId、结果摘要和版本恢复 approved，不重复执行。剩余失败是看板阶段从标题改为稳定 ID 后的旧静态断言，随后更新；真实渲染另见第 7 轮。原始输出见 round-6-recovery-tests.txt。
