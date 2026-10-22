## 问题与结果

移除每个Task“至少3个、最多10个执行会话”的强制规则。统筹按实际复杂度、独立性、依赖和协作成本选择直接处理、单执行或多执行；单/双成员交付齐备可完成，第11名及更多成员可正常派发。保持DSH为默认后端，停止本轮Claude原生Teams接入，不混入未交付的CLI认证候选。

## 实现

- `packages/dingtalk-dsh-assistant/task-session.js:38` 同步统筹、完成及交接指引；删除人数校验函数。
- `packages/dingtalk-dsh-assistant/task-session-service.js:907` 去除执行成员的3–10提示，完成入口不再按人数拒绝。
- `packages/dingtalk-dsh-assistant/dynamic-task-store.js:896` 新执行沿既有幂等和身份检查创建，删除累计十人门禁；同一执行单飞、并发容量、资源锁、未知效果与排空保护不变。
- README、部署核验说明及跨轮模型验证脚本同步按需人数规则；旧失败/历史执行文档保留。

## 关键实现

`packages/dingtalk-dsh-assistant/dynamic-task-store.js:896`

```javascript
      const executionId = a.executionId ?? randomUUID()
      if (get('dynamic_executions', executionId, true)) fail('DYNAMIC_EXECUTION_EXISTS')
      const instructionScope = coordination.scope(task.taskId, 1)
```

到达这里前已检查同一dispatch key的幂等和参数冲突，现在不再按累计人数拦截新成员。`task.complete`仍通过同文件866行的`assertClear(task.taskId)`检查执行和未决效果，成员总数不限不改变运行容量。

## 验证

- [x] `node --test test/dynamic-task-store.test.js test/dynamic-execution-resources.test.js`：123 PASS、0 skip；12成员登记/结果/排空/续办/重开，幂等和资源保护保留。
- [x] 原生Host定向7项：0/1/2/11成员、默认DSH、同会话续办、两轮文档旧SHA不变、未排空/unknown阻止完成且不重放。11成员实际写读11文件和文档，并发≤2；按原45000ms超时配置单独复跑1PASS，日志总耗时49.267秒，不承诺墙钟45秒内结束。
- [x] `node --test test/task-execution-resources-native.test.js test/task-session-model-native.test.js`：8 PASS、0 skip，验证资源互斥、成员直接通信实际消费和原生模型选择。
- [x] `node docs/acceptance/task-collaboration-quality/scripts/evaluate-model.mjs --check`：PASS、模型调用0，旧人数函数依赖已删除。
- [x] `pnpm test:release-smoke`首轮12 PASS、2个包用例30秒超时；使用本轮真实固定tarball沿已有`RELEASE_PACKAGE_DIRECTORY`入口执行`node --test test/task-session-package-native.test.js`，原30秒配置下2 PASS（21.994秒/6.057秒）。首错未覆盖，最终14项均有通过证据。
- [x] 独立源码/测试SHA和语义审查通过；当前现场只读回查默认`dsh`、健康`ok`、恢复告警0。
- [ ] 新代码本地部署：待合并后按原生退出切换runbook部署并独立回读；当前现场健康不代表本PR已安装。

## 风险与边界

没有schema、默认配置、权限或并发上限变更；保留已有任务和原会话身份。回退会恢复旧人数规则。原生验收使用真实Host、文件/进程和持久账，模型由可控适配器提供，不声称验证真实模型每次拆分质量或实际钉钉业务。未触发CI；普通分支/PR没有自动CI工作流。详细首错和新轮证据见`docs/acceptance/task-collaboration-quality/round-18.md`与`round-19.md`。
