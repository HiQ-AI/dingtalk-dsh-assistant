# 第四轮：最终定向验证

```powershell
node --test test/message-workflow.test.js test/workflow-service.test.js test/message-ledger.test.js test/execution-store.test.js test/observer-client.test.js test/http.test.js
```

结果：215 项通过，0 失败、0 跳过，25728.6767 ms。完整原始输出：round-4/targeted-tests.log。第三轮阶段目录断言已同步 material，C05 局部撤销与重复撤销回归均通过。

C01–C13 的用例对应沿用 round-2.md，增加上述 C05 边界。C14 沿用 round-1/browser-results.json：14 项浏览器检查通过、16 次只读请求、0 写入、0 页面异常；浏览器验证后前端代码未变。C15 为迁移锁、来源身份及备份对账，C16 为服务阶段目录断言，均在本轮通过。

该结果证明固定模型输出下的 Host 门禁、数据流和恢复行为；未覆盖真实模型语义质量、真实钉钉收发及线上延迟。未执行全仓测试，未迁移活动数据库或部署服务。
