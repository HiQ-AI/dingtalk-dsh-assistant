# 两项开发与 UAT 提测联合预检

日期：2026-09-26。SG15；本轮只有只读预检及方案记录，尚未重执行、创建新 PR、合并或部署远程 UAT。

矩阵新增 C33（归一化任务开发→业务验收→UAT提测）与 C34（评审草稿任务开发→业务验收→UAT提测），本轮均 NOT_RUN。

## 已确认对象

- Dataset `task-af34f1d5c616a1227a35fc3de58e70ad`，PR #371，head `40a7c3ecb008cdb648ff98cace73f67fdacfb7d9`，OPEN、base=main。
- Dataset Web `task-d2aa74700cc586d8c60f840d12e1a61f`，PR #368，head `b447f4826a353d6d82d7349fc7f571d9c831664c`，OPEN、base=main。
- 对应需求分别是归一化合并结果 1 t（排除 0.001 t）和评审意见保存草稿再进入回显。PR 当前状态已通过 gh 独立回读，见本轮两个 `*-pr-before.json`。

## 流程预检缺口

1. 当前两旧运行已成功且产生 PR，无 TaskOwner/任务计划。Web `reopen` 明确不支持 workflow-v2；context 需要 requirementRef；reissue 只适用无编辑/交付效果的等待任务。不能用它们硬重置历史。`task.plan.accept` 也拒绝给已有旧 execution_runs 的 taskID 直接建新计划。
2. `task-uat-pr-merge` 目录 unavailable。Host 写开关关闭且缺少合并目标；已配置的部署目标为 dataset-web UAT2、dataset UAT3。若本次两项都 UAT2，需登记独立后端 UAT2 白名单。
3. GitHub 两个 PR 的 check-runs、commit statuses 为空，UAT2 分支没有保护规则。现有分支上的 Woodpecker cron 成功状态来自合并后构建，不能当作 PR head 的合并前检查。当前代码的非空 requiredChecks 门禁不能填虚构名称，需先建立真实精确 head 检查。

审计回读后端 UAT2 资源：`hiqlcd-app-uat2/dataset`，generation/observedGeneration=515，readyReplicas=1；Woodpecker 仓库 1，cron `dataset-uat2-poll`，id=1、branch=`feature/uat2-base`；入口 `/api/dataset/ready` HTTP 200。仅证明现有环境可用，不是本次新版本交付。

## 专门业务验收

### 合并归一化

UAT2 候选实际提供 `/dataset/do-merge`，没有旧脚本使用的 `/dataset/merge-preview`。已有 `D:/baibu-agent/docs/acceptance/m5-unit-conversion/scripts/uat3-m5-fixture.py` 可参考 0.5 kg/声明 t 的构造与校验，但其修改固定旧数据及恢复方式不能直接用于本轮共享库；`uat3-m5-page-e2e.mjs` 改写预览响应，不能复用作真实证明。

正式场景需创建本任务专属两来源、回读前置条件、真实合并、回读结果为 1 t，并清理全部新增关联数据。当前合并涉及 processes/doc/core/data、建模校验、activities 等，不能只删主表。尚未盘点完复制及清理关系，尚未查询或修改实时业务数据。

### 评审草稿

旧 PR 的草稿保存到 `localStorage`，不是数据库；新增测试仅源码正则检查。可使用受控账号已有且未提交的 reviewer 对象，真实 DOM 填写→保存草稿→离开→同上下文再进入→逐字断言回显；禁止审批提交、分配及上传写接口。无合适授权对象时阻塞，不注入权限或页面数据。清理浏览器上下文及认证会话即可，不必为此创建审批业务数据。

## 下一步

已询问用户本次两项远程提测是否都用 UAT2，尚未收到答复；不能把上一轮本地接入选择默认为所有远程任务。确认环境后先补正式可追溯重执行入口、专门业务场景和真实 PR 检查，再串联开发→UAT合并→精确版本部署及功能回归。方案见 `docs/spec/development-uat-reexecution.md`。

没有修改业务代码、当前运行配置、旧 PR、活动数据库或发送钉钉消息。本轮不能报告完整流程通过。
