## 问题与结果

图文消息承接中，固定请求仍要求模型重写身份，空参审阅反复失败；路由缺少可直接复制的候选读取参数，Task分页未保留查询条件。重复完成会改写updatedAt，看板又使用它作语义终态；来源结算还可能等待同群其他Topic排空。本PR修复这些合同与时钟，补入站子阶段和共享事件循环延迟。

历史入站135405ms的精确阻塞点仍未收敛：附件在接收127.519秒后创建，多会话同期停顿，但缺少原始资源/存储子阶段trace。当前同图隔离实测2.150秒不能证明历史故障已消除，本PR保持Draft。

## 实现

- `packages/dingtalk-dsh-assistant/topic-runtime.js:511`、`:1022`、`:1045`：Host绑定固定请求/Topic，显式错请求与旧版本继续拒绝；路由无唯一Topic仍拒绝空参，提供完整候选readCall和摘要，不默选。
- `packages/dingtalk-dsh-assistant/task-topic-coordinator.js:15`：当前目录指纹、normalized query和完整nextCall共同计入12KiB预算；不隐藏缓存，不代替已有Task完整目标/版本核验。
- `packages/dingtalk-dsh-assistant/task-session-service.js:647`、`:781`：首次Topic完成后立即投影来源；入站保持原同步接纳顺序，新增资源读/图片保存/消息串行存储/来源读写计时，已知sourceId直接落stage避免逐阶段读取全群来源。
- `packages/dingtalk-dsh-assistant/store.js:1088`、`packages/dingtalk-dsh-assistant/http.js:149`：首次完成不可变，历史缺证不回填，来源未终态时不提前显示Topic时间；通知与恢复不推进语义时间。

- `packages/dingtalk-dsh-assistant/topic-runtime.js:489`：每个新话题版本从当前群任务生成有界关联读取入口及完整小快照；大正文仍精确读回，预算紧张先移除可选预取，不沿用旧会话审批。现有来源/Topic/Task版本与反馈guard保持。

## 关键实现

`packages/dingtalk-dsh-assistant/store.js:1088`

```js
      if (previous?.status === 'completed') return previous
```

在原有group串行锁内提前返回，重复恢复不触发持久化更新；首次完成事务仍校验所有动作已落账，再写completedAt并应用真实摘要。

## 验证

- [x] 本次整合代码：7个相关文件定向回归 **381/381 PASS、0 skip**，包含空参数/错请求、话题修订保留未答来源、Task更新拒绝旧快照、完整/超量/超长/跨群上下文、重复完成和独立通知时钟。
- [x] 本次当前原生profile：`node --test --test-concurrency=1 test/task-topic-routing-native.test.js` → **13/13 PASS、0 skip**；两个新话题版本均从关联入口核对大正文，目录读取0，原Task及需求版本不变、发送0。
- [x] 受控原生前后实验：仅换回main基线的原始协调适配器时，快Topic已完成但source仍pending，**5秒观察超时**；当前PR的完成回调使其在快Topic完成后 **11ms** 落戳，另一慢Topic仍阻塞。证明该阻塞路径，不倒推历史30.7秒的全部内部耗时。
- [x] 27任务、3条来源的确定性读取策略对照：原PR head `122c1ce6` 为4次目录＋1次完整正文；本次为0次目录＋1次完整正文，完整目标一致、来源保留、业务效果/发送0。**不是实际模型秒数基准**。
- [x] `git diff --check` PASS；复现实验、机器可读结果及原始合成日志见 [本次整合验证](docs/acceptance/semantic-latency-317-319/round-1.md)。
- [x] 原head `122c1ce6` 的既有#320验证保留：真实DWS与隔离ingest为2149.596ms；同路由low模型在图片准备后32796.969ms、3 streams、0无效/0重复，真实Task写入/渠道发送0。原作者此前定向、native、UI与14项发行smoke证据及第4/5轮FAIL均保留于 `docs/acceptance/quoted-deployment-handoff/round-6.md`；**未将两次独立计时相加，也未冒称本次源码重新跑过真实模型或打包smoke**。
- [ ] 历史#320入站135.405秒、#317–319投影约30.7秒的完整内部trace均不可恢复；受控实验不能替代历史缺失证据。
- [ ] 正式实例部署、原消息现场重放/补发、本次新真实模型提速测量未执行；未主动触发CI。

本次结果以 `docs/acceptance/semantic-latency-317-319/matrix.csv` 为准；既有#320验收以 `docs/acceptance/quoted-deployment-handoff/matrix.csv` 为准。PR继续保持Draft，未合并或部署。

## 风险与回退

新增决策completedAt为可选持久字段，无DDL迁移；旧记录不回填推测完成时间。事件循环采样反映共享Host，不能单独归因某消息。一次真实模型通过不能保证未来永不缺参。回退使用原包与现有runbook，保留原任务/来源/通知身份；本PR没有业务数据修复或现场重启。

