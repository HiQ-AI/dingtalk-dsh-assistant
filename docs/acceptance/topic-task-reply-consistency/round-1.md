# 修复前发送顺序复现

命令：`node --test --test-name-pattern='已建 Task 后故障|任务动作拒绝' test/topic-runtime.test.js`。

结果：2 tests，0 pass，2 fail。动作提交后异常与动作执行前拒绝两种路径都已生成 1 条回复，预期 0。此轮只证明错误发送顺序；来源回声因果另由现场固定话题历史及只读动态来源查询定位。
