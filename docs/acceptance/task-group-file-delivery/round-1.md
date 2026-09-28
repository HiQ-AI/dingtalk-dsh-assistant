# 渠道合同验证

用户指定的测试群唯一解析。DWS 1.0.61 使用 user 身份、显式 profile、相对文件名及稳定幂等键发送一份标注测试的 Markdown。

独立发送状态查询取得真实消息 ID；消息回读给出唯一 fileId 资源（没有 messageType 字段）。下载 129 字节，SHA-256 `a39960b72f7241475fe0467495ba6180884424045d2f0694b6c495ecc3b529c0`，与本地原文件相同。

原始渠道记录仅留在本地忽略目录 `round-1/`，不提交群 ID、profile、消息和本机路径。配方见 `scripts/probe-dws-files.mjs`。这轮验证渠道合同，不代表 Task 全链路通过。
