# 第 1 轮：基线与失败修正

现场只读状态：任务 requirementRevision=2，原失败执行 requirementRevision=1，providerRecovery.exhausted=true、attempts=3，nextReviewAt=2026-10-19T08:02:25.429Z。统筹在 08:02:36Z 提交等待，没有续办工具调用。

使用 HEAD 的 dynamic-task-store.js 配合新增修订复核用例，运行 `node --test --test-name-pattern='provider cold review.*revised$' test/dynamic-task-store.test.js`，1 FAIL。实际返回 DYNAMIC_EXECUTION_NOT_CURRENT，确认版本门禁先于冷却检查拒绝复核。之后以 finally 恢复修复文件。

首轮测试编写中修正两项夹具问题：模拟执行缺少 sessionBound，模拟未知操作缺 resourceKeys；原生测试还修正了成功结束后 providerRecovery 会清空的错误断言。这些不作为产品故障证据。
