# Round 34：工程原生会话受管归属

## 结果

新工程原生会话以 origin=subagent 创建。旧普通会话在原生 idle 维护锁中校验 Task/node/input、完成回合、无额外输入，再完整 seed 派生受管子会话；旧观察句柄保留。Controller 及 worker CAS 保持原 Task/Run/node/generation 和成功前缀。维护准备要求精确维护 id/revision，不 schedule/claim。

## 实跑

- `node --test test/execution-session-native.test.js test/execution-controller.test.js test/execution-store.test.js`：179 项，初轮 177 PASS；两项 controller 失败由新增测试时误替换旧断言导致，精确恢复旧断言后重跑 `node --test test/execution-controller.test.js`，63/63 PASS。native/store 原整轮 116 项均 PASS。日志分别在 docs/tmp/managed-session-regression-final.log 与 managed-controller-final.log。
- 新定向 13 项覆盖 origin、idle 观察保留及 child 续行、当轮 lease 拒绝、foreign/pending 输入、identity 漂移、准备后 CAS 拒绝的确定性重试、restarted/running-reserved 换绑、revision CAS、维护身份及 claim 拒绝、Controller 不调度且保留成功前缀。
- 两份真实历史 JSONL 仅复制到隔离 docs/tmp 后执行新适配器：dataset 最后输入 lease2 / 继承92事件，production lease1 / 继承568事件；两者均成功准备子会话且模型请求0。对应 sg14-real-child-dataset.log、sg14-real-child-production.log；私有原文副本不入Git。

## 边界

本轮未部署、未调用 live 写操作，未重启或处理真实业务。完整回归日志保留真实初轮失败，最终通过由定向重跑证明；不把本地测试等同现场恢复。维护 Bridge 须使用正式 Loader/控制账独占、真实受信 workflow 模块与内部 prepareManagedSession 接口，不能直接修改数据库或伪造原生header。

## Review 收窄补验

发现原生 runMaintenance 不阻止 inbox 插入，故最终方案删除 drive/recover 自动派生，拒绝所有外部已附着会话；历史迁移仅通过正式维护桥，在 Resident 和 API Session Controller 均正式卸载后自行 resume 冷会话。维护 CAS 现在始终必需。新定向12项全部PASS，日志 docs/tmp/managed-session-narrowed.log；其中 external-observer 明确拒绝且不调用 onPrepared，封闭借用观察句柄期间输入竞态。之前观察保留用例已被冷会话准备与外部观察拒绝替代。

维护 profile CLI 仅在隔离fixture执行四步 disable-controller/install/remove/enable-controller；每步 --check 字节零变化，四步后原profile逐字节恢复。现场未写。

收窄后完整再验：controller + native 两文件 112/112 PASS（managed-session-narrowed-regression.log）；store定向7/7 PASS（managed-store-narrowed-final.log）。私有维护桥 profile安装锁竞争仅EEXIST每100ms重试、最多5秒，每轮重复profile与Loader门禁；隔离fixture确认CLI仍持锁时等待，释放后第2次成功。桥报告含PID、maintenance、closed；关闭失败不得报告complete。本轮仍未现场执行。
