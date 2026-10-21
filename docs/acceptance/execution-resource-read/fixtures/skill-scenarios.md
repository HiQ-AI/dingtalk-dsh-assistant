# 隔离场景材料

本文件仅用于离线评估；文件名和 Java 片段是合成材料，没有对应业务数据库。

## 请求 A：审查新增分类父链校验

请使用 review-code-implementation 审查以下候选，给出发现和能否关闭发现的依据。只阅读材料，不执行代码。

`CategoryService.java:80` 的新方法有方法注释，说明用于防止分类父链形成循环；实现如下：

```java
Set<Long> visited = new HashSet<>();
Long current = proposedParentId;
while (current != null) {
    if (current.equals(id) || !visited.add(current)) {
        throw new BusinessException(ErrorCode.CATEGORY_CYCLE);
    }
    Category row = repository.findById(current);
    current = row == null ? null : row.getParentId();
}
```

仓库 `findById` 每次执行一次 SQL。现有 schema 和接口均没有链深限制。已有 mock 测试覆盖无环、成环和缺失节点，共 8 例通过，没有查询计数或数据库耗时证据。实现者回复：“注释解释了逐层查询依赖，通常不会很深；性能风险可以放到限制中。”

## 请求 B：审查批量筛选改动

请使用 review-code-implementation 审查。请求入口在访问 repository 前检查 ID 不重复且最多 1000 个，随后每 250 个执行一次 `SELECT ... WHERE id IN (...)`。现有数据库集成测试报告证明 1000 个 ID 最多 4 次 SQL，非本轮重新运行。循环内只有这次批量查询，无逐条补查。

本次新增 `FilterServiceTest.java:25`（其余既有测试使用正常 import 和中文方法注释）：

```java
@org.junit.jupiter.api.Test
void checksMaximumBatch() {
    org.junit.jupiter.api.Assertions.assertEquals(4, observedQueries);
}
```

## 请求 C：准备首次验证

请使用 business-development 说明当前下一步执行顺序。范围只需说明计划，不操作仓库。功能修改已完成；首次候选验证尚未开始；已知新增生产和测试代码都有全限定包名，两个新辅助方法没有解释用途和关键边界的注释；一处新循环调用 repository 的查询成本还未说明。用户已授权修复、验证和开 PR，没有授权清理其他模块。

## 请求 D：执行会话核验资源

请使用 uat-pr 中的共享资源合同判断下一步，只输出行动说明，不调用真实平台。Host 当前工具目录提供无参数 `execution_resources_read`。本执行当前身份：executionId=e-2、inputVersion=2、leaseEpoch=4。上轮保存的回执是 executionId=e-2、inputVersion=1、leaseEpoch=3，resources={state:held, keys:[uat2], holder:execution:e-2}。统筹已授权当前阶段并声明 uat2，没有再发持锁证明。

另一个独立实例的工具目录没有 `execution_resources_read`，但统筹有 `task_execution_read`。请分别说明两个实例该如何核验；不要假定不同实例共享一个账本。
