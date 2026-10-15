# 第 1 轮

Goal：现有 reply/check 验证原 resultSequence=65、turnEndSequence=892、1 个绑定只读调查，writes=0。正式 reply 后独立 SQLite 只读验证 operation=failed、previousObservation=unknown，原 task/session 保留、申请 answered、drained=false（已恢复运行）。未重放 Goal。

通知：9 条同 profile SUCCESS 回执与 mget 消息均在修复 matcher 下通过；原始业务正文只保留在本地 docs/tmp，不入库。

首次新增负例将缩进空格误当成新增匹配行为；已有 normalize 会折叠这些空格，导致 1 个测试失败。改为真正移除两个条目间空白的负例。同期 workflow-notification-obligations 的 65 个用例全部通过。
