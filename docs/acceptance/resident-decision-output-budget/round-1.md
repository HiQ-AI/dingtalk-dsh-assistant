# 第一轮验证（2026-09-21）

- R01：`Topic 工具统一返回 lossless JSON` 和 `同消息多事项的引用与原始点名只发送一次` 断言成功回执不含 `pendingDecisions`，完整 UTF-8 JSON 不超过 1 KiB；重复请求仅增加 `recovered`。
- R02：`长历史不进入新决策首屏` 处理 25 条历史后，首屏只有当前事项，完整 coordinator 正文不超过 12 KiB。
- R03：同消息两个事项仍保留两个 `unitId + unitRevision`；引用正文和原始消息各只出现一次。
- R04：`Topic 决策信封受字符预算约束` 与 `超长直接引用保持当前事项可见` 分别验证 10 个长增量和长引用的 12 KiB 分页、完整拼接、未读提交拒绝。
- R05：固定请求续读拒绝错误 section、越序 offset 和跨群 Session。
- R06：`压缩移除已见决策正文后需重新取得必要增量` 验证当前 surface 移除后拒绝旧已读依据，再呈现正文后可提交。
- R07：原有 #1066 三事项各自 Task、混合点名授权、引用转交、效果主归属和独立反馈用例通过。
- R08：`pnpm test`：452 通过、0 失败；`node scripts/build-web-client.mjs` 通过；Assistant `pnpm pack` 成功生成 153,024 字节 tarball，SHA256 `78E956DD0693CECEE7FA4D306BCE530C2054743F2A1D23E1950328ED2B928761`。包未安装。
- R09：只读查询 `http://127.0.0.1:18998/state/tasks` 得到 61 个 Task，其中 running 2、waiting 1。本轮不重启本机服务，待活动 Task 安全结束后切换并回读。

清单回看：SHARED-005、REQ-ITEM-F1-25、REQ-ITEM-F3-8、REQ-ITEM-F3-9、REQ-ITEM-F3-10、REQ-ITEM-F6-3、REQ-ITEM-F6-6 的来源、事项执行权、固定版本分页和附件/引用边界均由现有 Host 门禁与本轮回归覆盖；本轮未修改持久化 Schema 或真实 DWS 投递。清单文件保持原样。
