# Round 49：后端单测检查去除跨需求硬编码

## 原因和范围

1edb候选验证实际Maven返回No tests were executed：Host脚本固定选择MergePreviewCalculatorTest/MergeWeightAllocatorTest，并且Java XML校验和JS摘要同样固定这两类。真实候选不存在两类，其他测试已编译，因此不是候选缺需求测试的直接证据。

同源属于本仓 scripts/verify-dataset-unit-tests.mjs 与 scripts/LocalAcceptanceBackground.java。正式旧工具位于 D:/dsh_home/workflows/runtime-v2/local-acceptance/tools/a9087af648c6d7479cf08803036a3c72f8cb44273256b66621990032b11c7a83；本轮未写该目录。

新规则使用Maven原生 `Test*,*Test,*Tests,*TestCase,!*IT,!*ITCase,!*E2ETest` 选择。Java动态核验本轮UUID全部XML，拒绝无报告、tests=0、失败、错误、跳过、suite伪造或case计数不符；JS记录同批报告SHA，不再绑定Merge。

## 候选范围审阅

对真实candidate的src/test全文rg核对SpringBootTest/ActiveProfiles/DataJpaTest/Testcontainers、数据库连接与网络客户端调用。Spring上下文命中仅MessageEngineIT、LcaCalcTaskOwnerIT、ExpansionCrossDbReuseE2ETest；SQL连接另命中SyncEnginePgIT和非测试命名AcceptanceRunner。普通测试中两类gRPC单测使用localhost（测试内本地server或故意不可达端口），不是共享业务服务。未发现被选择普通单测显式启动Spring业务上下文或直接连接数据库的证据；静态关键词审阅不等于完整外部效果证明。

按规则选择83类，排除7个非单测/集成类。完整类清单private docs/tmp/backend-unit-test-scope.json；没有执行真实业务repo测试或改业务repo。业务E2E独立验证。

## 实跑

```powershell
$env:JAVA_HOME='D:/soft/jdk-11.0.2'
node --test test/verify-dataset-unit-tests.test.js
```

4/4 PASS（最终4.12秒），真实javac/java编译运行验证器；覆盖不同于Merge的测试类、当前随机后缀、缺报告、零用例、跳过、失败、错误、伪造suite、计数不符。配置提案构造器测试保持通过。

只生成private tools SHA快照和docs/tmp/backend-unit-checks-proposal.json：完整checks，dataset-package v3，仅第一步tool路径变化，保留package步骤和所有其他参数；工具两文件SHA已随提案记录。旧prepareBackendChecks是首次加入单测专用，不直接用于已存在双step的活动定义。交主线程经维护checkpoint接纳；本轮未写正式Host、profile、Assistant源码或包，未提交部署。
