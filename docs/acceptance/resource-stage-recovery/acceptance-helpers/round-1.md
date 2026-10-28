# 首轮失败记录

2026-10-28，隔离 localhost fixture 调用实际已安装 PowerShell helper。

首例 `raw-utf8-bytes`（合法 OCI manifest，保留中文、缩进、末尾换行）预期 exit 0，实际 exit 1；因此首轮未通过，其余用例未执行。不改 fixture 或放松验收预算，定位脚本实现后重新独立执行。

诊断补充：白名单结果为 `request_failed`、未取得 HTTP 状态。仅对 localhost 无真实凭据的诊断副本展开异常，定位为 fixture 省略 Content-Length 后，Windows 连接关闭时不稳定出现 SocketException 10054；再次运行曾首例成功、第二例失败。给本地 HTTP fixture 补准确 Content-Length，明确响应帧边界，未改变响应正文、预期结果、生产 helper、超时或重试预算；下一轮重新完整执行。诊断副本仅本地保留，不入交付。
