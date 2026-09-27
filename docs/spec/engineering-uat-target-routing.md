# 工程 PR 的 UAT 目标与 main 上线边界

## 当前问题

工程 registry 把 config.baseBranch（默认由 baseRef 推导）直接作为 PR base；消息参数没有 UAT 目标，因而用户未指定 UAT 时也会向 main 提 PR。当前生产发布流程核对已合入 main 的来源，不等于普通开发可提交 main。

## 实施

新增明确参数 uatEnvironment（uat1至uat9），Host固定映射 feature/uatN-base，模型不提供分支 并贯穿消息澄清、任务需求、修订和 registry 固定配置。工程接纳缺失或未在原消息/澄清回答中出现的 UAT 分支时，返回 needs_clarification 询问；main/master及非UAT命名拒绝。registry再次校验合法Git分支且远端真实存在，把明确目标写入持久配置及幂等摘要。代码基线 baseRef 与 PR 目标分开；不从 main 基线猜目标。重发也必须携带或复用已明确的UAT环境。既有历史定义不改写，外部PR效果门禁拒绝main目标。

main PR 合并提供独立 task-main-pr-merge，由受信Host adapter核对精确PR/SHA、main目标、UAT与业务验收证据、真人批准，再准备/执行/独立回读；未配置适配器即不可用，不用开发流程代替。复用现有外部效果授权与流程目录，不自动合并已存在PR。UAT合并新定义也校验UAT目标，旧定义可恢复但不能借工程入口产生main PR。

## 范围

不修改PR371目标或执行任何实际合并，直到用户明确UAT目标。历史任务保持历史；明确分支只授权对应目标，不授权上线、tag或生产部署。源码、隔离回归、本地安装分别留证。
