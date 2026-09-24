# M2 受管代际目录最终验证

2026-09-23，沿用round-6环境。

## 实跑结果

- `pnpm test`：**720 tests / 720 pass / 0 fail / 0 cancelled / 0 skipped**，78.1秒。本轮新增12项（adapter5、真实组合2、网关反例5）。
- 源HEAD/index/未提交文件保持不变；代际A删除与未跟踪文件保留在A，新代B精确从base创建；用户后续修改不被恢复流程reset。
- 目录创建并发唯一、残缺/陌生/链接目录不覆盖；metadata/HEAD冲突拒绝；取消/输入/撤权先落账阻断创建；跨run即使同generation与需求也拒绝。
- 初始化前后精确文件全集与blob SHA回读；marker持久化后才能成功。创建成功但回执丢失后，同身份只读对账，恢复不再clone。
- `git diff --check`通过；重新打包，独立tar目录读回11个execution模块（含workspace）。包SHA256：`41F839A83A816228303D3DC837D9DB4A192EE0534F21BF8669A6F0134C4C4E05`。

## 准入与未验证

workspace适配器只支持本地SHA1独立非bare源仓库。拒绝.gitattributes、hook、链接/gitlink、危险配置、alternates/grafts/shallow。不复制全局/系统Git配置，不运行项目shell。文件数量/大小有界，初始化残缺保持unknown，不提供自动覆盖或删除。

只读运行 `docker info --format '{{.OSType}} {{.ServerVersion}}'`：客户端存在，但docker_engine命名管道不存在，daemon不可用。因此独立执行环境和真实项目shell检查仍NOT_RUN；目录隔离不代表权限/网络隔离。M2的完整开发业务、平台PR、通知及后续消息链路还未完成。未合并部署、未操作生产任务。
