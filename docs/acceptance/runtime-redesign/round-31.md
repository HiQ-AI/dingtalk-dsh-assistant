# 本地运行实例切换（第 31 轮）

日期：2026-09-24。目标提交 `30784c9694b2dec99f8a899da768fb9f2c07d0d6`。

部署前只读回读：70 个任务 completed、1 个工程任务 waiting，没有 running；消息最新版本中两条归一化消息均 settled；发信箱仍有 2 条 pending，未清除或改写。旧实例 PID 40024 同时监听 3080/18998。v9 存储 `--check` 为 `ok:true`、`invalidRecords:0`、`strippedFields:0`。

停机后将 v9 JSON、workflow 控制库及其工件目录、profile manifest/patch 备份到仓库外 `D:/dsh-deploy-backup/30784c9-20260924`。JSON 的源/副本 SHA256 同为 `3E07251000979E41CED8F775A3B571FE1265542B0F70047D6C58B2D5746EAE7B`；控制库主文件源/副本同为 `6B081701FFF2C6331B9E8FD63B3FE449C232E4E79AD67D103FC1863E21688F0B`。整个工件目录按保留原文件方式复制，没有执行清理。

Assistant 精确 tgz 为 `docs/tmp/deploy-30784c9-20260924/zzusp-dingtalk-dsh-assistant-0.5.15.tgz`，SHA256 `289E68F28272C1B731DCF30B4A90188055D5316ED5D76BAB18E755E561F0CEC9`。使用 profile 内原生 CLI 安装；64 个源码/配置文件 SHA256 与提交工作区一致，Observer 依赖及 profile patch 未变。

新 PID 13932 同时监听 3080/18998，`/health` 为 `ok`、DWS healthy、`recoveryIssueCount=0`。运行中的 `message-workflow.js` SHA256 与工作区同为 `EEF914FE5652A1B25B52A696D4E4322E673E58AC283386D6AB348C3E6E589299`。workflow-v2 控制库仍为原实例；两条归一化消息最新版本仍 settled，任务仍 waiting，原因 `ENGINEERING_INDEX_CAPACITY_EXCEEDED`；70 个旧完成任务保留，2 条待投递通知保持 pending。任务表启动同步显示 success、16 条任务行。未登录访问 Web 根路径返回“需要认证”，本轮未将该结果当作认证页面验收。

实例切换通过；问题任务仍需单独修复 `index-files` 的 32 KiB 文件清单容量问题及固定工作流定义迁移。没有借部署重放消息或启动已阻断的工程任务。
