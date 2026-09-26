# 第二轮：组合验收

## 实跑

```powershell
node --test test/message-workflow.test.js test/workflow-service.test.js test/message-ledger.test.js test/execution-store.test.js test/observer-client.test.js test/http.test.js
```

213 项通过，0 失败、0 跳过，25.72 秒。完整输出见 `round-2/targeted-tests.log`。这是与本次改动直接相关的定向组合，未运行全仓测试。

## 用例到证据的对应

| 用例 | 实际断言 |
| --- | --- |
| C01 | 三条同话题只一次IB/一次Task；公共投影中unit仅持话题身份；sourceManifest含三来源 |
| C02 | 205话题后引用最早来源，R仍找到原话题，零新Task；历史游标读取无遗漏 |
| C03 | 第九候选第二页匹配，重复process不重发；第一和第九明确引用同首页受保护 |
| C04 | 小材料中段租户/日期保留；超过12000B逐页引文与覆盖首尾；伪造quote或complete=false零派发 |
| C05 | 原提出人撤销“仅排查”后旧约束进入superseded审计；另一发送人同句待澄清且零Task |
| C06 | 一千条历史跨页/重启保留；1003条有效记录在IB投影为4条，异actor/异constraint不合并 |
| C07 | 有效约束本身超过IB容量，记录MESSAGE_CONTEXT_CAPACITY且零命令/零效果 |
| C08 | IB期间任务语义变化旧动作不派发；Run状态变化时接纳事务原子拒绝旧hash；来源编辑既有回归通过 |
| C09 | 材料第0页成功、第1页临时失败后重建workflow，复用成功页、只重试失败页，效果仅一次；存储重启/幂等回归通过 |
| C10 | 三个MessageRun查询得到相同IB nodeRunId，实际IB调用仅一次 |
| C11 | Owner仅预留时sessionBound=false且无链接；历史Run/节点分页与空态真实展示 |
| C12 | 跨群trace/topic/task不可读；未绑定ref、伪造hash/续页拒绝；事实冻结revision和HTTP参数合同覆盖 |
| C13 | 未知usage显示未知；确定性分支零模型调用；材料重试共享累计预算、成功页不重复调用 |
| C14 | 完整React页面14项实跑，事实/批次页独立、返回保页、旧响应不覆盖、窄屏及键盘可用 |

## 边界

- 模型使用固定、可审阅的测试输出，证明 Host 的数据传递、引文校验、版本与执行门禁；没有据此声称线上模型零语义遗漏。
- 当前投影仅合并同人同文事实，不用模糊总结删除不同条件。不同条件继续增长时可能达到容量门禁。
- 材料、候选和IB共用原有累计预算；大型必要集合可明确受阻，不承诺任意长历史总能自动完成。
- 浏览器使用隔离只读夹具。没有迁移活动库、安装发布包、重启真实服务或发送真实钉钉消息。

## 后续复审更正

C05 后续发现局部撤销和批次重复撤销边界，此轮矩阵标为 FAIL；修复与最终通过见 round-3.md、round-4.md。
