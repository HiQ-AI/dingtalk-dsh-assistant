# 第 27 轮：v12 本地部署与话题环境核对

## 本地部署

- 独立本地包：docs/tmp/branch-reuse-deploy-20260926/zzusp-dingtalk-dsh-assistant-0.5.15.tgz。
- SHA256：C719BF166C14F2001E16483A20E19DF313B4213CB6084792E2D7429AEF58830F。
- 先零写检查，73 个任务均已完成；领域存储 invalidRecords=0。
- 停机备份：D:/dsh_home/backups/branch-reuse-20260926-222439。
- 安装后 81 个 JS/YML 文件逐一匹配；配置 SHA 保持不变。
- 新进程 PID 51924，仅 loopback 3080/18998。启动初期 18998 尚未监听，待服务完成启动后独立回读成功。
- health=ok、recoveryIssueCount=0、inboundProcessing=true；认证 Web 200、流程目录 200；73 个 taskId/state 与部署前一致。
- 回读脚本与结果：docs/tmp/branch-reuse-deploy-20260926/readback.mjs、readback.json。

## 从原话题确定提测环境

用户要求先查话题而非再次询问。只读回查消息控制账及原文引用链：

1. Dataset task-af34… 的已接纳命令绑定 topic-dataset-normalization-20260924；报错 msgoNfn4Aw4blhFYC9brshREw== 直接引用 msg3hknXdgtAOOUorbNEQjJaQ== 的 UAT3 单位修复提测消息，要求修复该交付引入的归一化问题。沿该来源链承接 UAT3，目标 feature/uat3-base。
2. Dataset-web task-d2aa… 绑定 topic-4a1030692473c69b85d9af3c4cc99cde；原报错引用 msge3nNE1Ai2dHAh9wDdCnQlg== 的审核问题 UAT2 回复，同一消息链有“我审核的问题都改完部署到uat2了吗”。沿该来源链承接 UAT2，目标 feature/uat2-base。
3. 两个开发分支均保持原任务记录。不得将历史提测消息当成本次部署成功证据。

证据：同一目录 task-sources.jsonl、quoted-sources.jsonl、三个相关 topic JSON。当前任务列表 topicRefs 为空，但原接纳命令保留话题绑定，不能据空列表断言没有关联话题。

## 继续验证

正式 Web 重执行入口、专门业务验收场景和 UAT PR 检查仍在补齐。尚未运行两项真实开发→验收→提测，C33/C34 保持 NOT_RUN。
