# 第21轮：受阻连接器下的接收、共享条件和控制隔离

日期：2026-09-24。仅新增测试；未修改实现、未操作运行实例、未发送渠道消息。

## 实跑

```powershell
node --test --test-name-pattern 'C01|C02|C09|C13' test/message-workflow.test.js test/workflow-service.test.js
```

最终运行结果：4 tests，4 pass，0 fail，0 skipped，632.0324ms。测试通过挂起 Promise 模拟真实接口未返回，由显式 release 解除，不依赖 sleep 或提前伪造连接器完成。测试级 timeout 只负责失败时结束，不参与成功路径计时。

| 用例 | 新增测试位置 | 释放阻塞前的断言 | 释放后的断言 |
|---|---|---|---|
| C01 | `test/workflow-service.test.js:278`“媒体连接器挂起不阻durable接收和独立SQLite读回” | `readResource` 已进入且未返回；`service.ingest` 已返回runId；经真实 SQLite 独立 query 回读原正文；commands及业务run均为0。 | 材料返回后原消息继续，命令applied。 |
| C02 | `test/message-workflow.test.js:218`“共享材料连接器暂停时所有相关事项均不接纳，独立版B可先执行” | 配对测试：只有A依赖材料时B先到handler，sent仅查B；改成A/B均依赖同一必要规则并持有共享限制后，两次材料调用都已进入且未返回，sent为空、账本commands为0。 | 两个单元均完成，查A与查B各有归宿。 |
| C09 | `test/message-workflow.test.js:233`“业务创建handler暂停时独立状态及取消handler先接纳” | create handler已进入且未返回；两条独立状态/取消消息依次settled；记录只有status、cancel，没有created。 | 释放后业务创建handler才返回。 |
| C13 | `test/workflow-service.test.js:288`“渠道读回挂起时新业务和取消继续，ACK不冒充送达” | 先限制披露，独立回读prepared；允许发送后ACK已记录为acknowledged，readback已进入但未返回，未记录delivered。此时第二个真实Controller任务成功；首任务仍可通过任务视图查询、通过Web身份服务接纳cancel，stopRequested为true。 | 释放执行与渠道readback后首任务cancelled；原通知独立查询为delivered且只有1条，未把ACK当送达。 |

## 覆盖边界

- C01/C02/C09/C13 的上述可控故障场景通过，补足 round-20 中相应的接口隔离与共享条件反例；没有据此将全部C01—C13改为PASS。
- C02共享依赖由受控S输出明确声明；证明运行器不会绕过已识别共享条件，不证明真实模型可以对任意自然语言正确识别共享范围。
- C09模拟业务启动handler不返回，证明调度层不占住独立控制路径。C13另用真实SQLite和Controller验证cancel接纳；没有实际挂起生产Agent启动或杀生产进程。
- C13渠道适配器为受控接口；没有真实钉钉外发及读取生产消息。证明状态与执行隔离，不承诺真实网络延迟。
- 未进行真实provider负载、共同配额、p95/p99或生产SQL审批验证；这些仍按 round-20 未覆盖项处理。
