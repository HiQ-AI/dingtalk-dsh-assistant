# 已发过时确认消息更正

用户指出仍在群里索要UAT的通知未与实际任务对齐。原消息完整正文唯一定位至 notice-2d597617b081aa7231ccae9f9e54394b0a7a577c8aa6190c6932d2d10ec80fe9；当前Task需求版本2已确认UAT2且文档已完整读取。

## 修复与验证

受信本机维护身份原先只允许explicit_user，无法使用已有restore/correction正文替换合同。本轮仅允许此身份执行restore+correction，其他理由、错误身份、未撤回通知仍拒绝；不变更Task需求或扩大自动通知。

- 服务定向2/2 PASS，1227 ms；包括群负责人原授权路径、本机撤回、纠正正文、错误身份/理由、快照、幂等及独立replacement回读。
- 通知义务及恢复工具61/61 PASS，26719 ms。
- 原指定通知撤回 completed，独立只读通知账 recallStatus=recalled、DWS回读工件 `sha256-d02f1e675ada4bc89b6f84cb3078ac422791668ab189746754c4bd021dfb1446.json`；相同正文通知总数1、当前可见数0。
- 同Task更早一条“文档无法读取/UAT未定”过时通知也经原生撤回，回读工件 `sha256-bdeb6af36efbd0e3452b2727207c345283c2c56562a2f2dfb3c7d4a02294a1d1.json`，保留开始通知与审计。补发只做一次更正。

## 部署与补发

包SHA256 `527d1515f764e6db1f19ce62aece19a9aeaba65ad451acdcf299b47ddcddd222`，100文件与源码一致，Check零写通过。新进程及更正补发需独立回读后记录。

## 最终独立回读

新包安装100文件一致，PID70428，health=ok、inboundProcessing=true、recoveryIssueCount=0，原5个Task保留。两个旧通知的recallStatus均为recalled；更正operation completed，notification-replacement恰好1条，绑定原指定通知。

更正消息ID `msgsUTdzT6LcCxoUVE5ZjKllg==`，DWS独立回读工件 `sha256-75393cc1dd6a60042b8e5aed863a19e12b4168ad057dd11c12161916bbaaa3f0.json`，observedAt=2026-10-08T07:07:39.244Z。正文为：

> 更正：本次开发测试环境已确认使用 UAT2，UAT1 保持不动。需求文档已读取，无需重新分享，也无需再次指定环境。原开发任务继续处理。
>
> - 小小鹏代回

没有修改Task需求、重放交办或另建Task。本轮仅纠正已发通知及受信更正入口。
