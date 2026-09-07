# 第五轮：Windows 真实数据迁移修复

2026-09-07。本地部署读取 9,683,816 字节的 v6 domain，只读检查发现两个已完成且已归档的历史 E2E Task 对应 Group 已删除；完整原文件、Web profile package 和 lockfile 已保存到 `docs/tmp/deploy-topic-f1fddc72/rollback`。仅在迁移副本中按精确 Task ID 删除这两个测试残留后，检查结果为 1 Group、876 Messages、30 Tasks、30 Topics、298 Outbox、0 issues。

原迁移实现通过 JSON SDK 对每条记录执行 `put`。该后端每次写操作都会重写整个 domain，真实数据运行约 15 分钟后在 Windows 临时文件替换目标时返回 `EPERM`，部分目标保留且未切换到运行目录。

修复后要求目标不存在，以 `wx` 排他打开并一次写入完整 v7 文档、flush 后关闭，再由真实 `JsonStorageBackend`/`DomainFacility` 重开并逐表核对指纹。真实迁移副本在约 1.5 秒内返回 `written: true, verified: true`；计数与只读检查一致。

验证：

- `node --test test/topic-migration.test.js`：6/6 PASS。
- `pnpm test`：233/233 PASS，0 fail、0 skipped。
- 真实 v6 副本迁移：1 Group、876 Messages、30 Tasks、30 Topics、298 Outbox，0 issues，目标重开验证通过。

原 v6 文件和匹配 Session 保持不变；本轮尚未把 v7 文件切换到运行目录，也未启动本地 Web。
