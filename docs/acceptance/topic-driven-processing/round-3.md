# 第三轮：持久执行归属与关闭通知修复

2026-09-07。补齐旧 Runtime 70 条测试的逐项行为映射，见 round-1/runtime-coverage.md。

- 已执行的消息改归其他 Topic 后，原事实版本仍保留执行归属；同一决策不得重复改变同一 Task，但可明确取消两个不同 Task。
- close 等待已经通过工具入口的通知提交持久化，再拒绝尚未提交的模型请求；避免提前关闭 Store。
- 实际 DSH 0.1.1-rc.2 + fake 模型完整链路 PASS：3 Topic、3 completed decision、1 completed Task、3 pending Outbox。Session JSONL 回读六类工具调用，见 round-3/native-dsh.json。外发授权关闭，pending 不代表已发送。
- 构建退出 0；3 个安装包实际存在且 assistant 包包含 topic-model/topic-runtime/runtime/store/web-client，字节数及 SHA256 见 round-3/packages.json。
- 全量测试 231 项中 230 PASS、1 FAIL，原始结果保留 round-3/full-tests.log。失败为关闭与工作区切换测试夹具仅等待 100 个 setImmediate，在真实 fs 回调前耗尽；未以重跑掩盖，改为 3 秒 deadline、5ms 异步条件等待，另补两个反例，第四轮完整复跑。

本轮之后仅修改测试等待和补充用例、文档；第四轮核对原生与打包证据对应的生产源码 SHA256 未变。
