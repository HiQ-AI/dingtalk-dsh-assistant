# 第一轮：本地机制、查询脚本与配置

- `pnpm test`：262/262，0 fail、0 skipped。阶段错误不写进度；结构化 expected 经过真实 DSH schema 验证和 JSON 渲染回读；按单项修正后推进，累计项仍拒绝。过期输入、非法会话等原错误路径保留。
- 首次 schema 使用 anyOf，被 DSH 本地测试明确拒绝；改为其支持的 oneOf 后通过，未改框架或放宽验证。
- 实际叶子工作区新增 `D:/baibu-agent/scripts/read-woodpecker-pipeline.ps1`。该工作区无 Git，因此脚本与其验证留在工作区，未将业务平台实现硬编码进插件 Runtime。
- `node D:/baibu-agent/docs/acceptance/woodpecker-pipeline-inspection/scripts/verify.mjs`：10 个独立 HTTP fixture 通过（在途、成功、仅失败、跨页、空列表、错结构、缺目标、未知状态、重复分页、HTTP敏感错误）；确认秘密不出现在 stdout/stderr。脚本只读，未改变远端。
- 真实只读回查 repo 2 / pipeline 257：扫描 258 条，正确查到 #257 failure、#258 success，equivalentBuildAbsent=false，blockingPipelineNumbers=[258]；输出不含 variables 或凭据。没有重跑构建。
- 配置脚本先 --check 再 --apply：taskPromptsVersion 1→2，原 UAT 流程 r1→r2，新增 workflow-uat-rebuild r1，总数 9→10；其余8项流程、leafSessionPrompt 及其他配置逐字段未变。独立读取 v7 存储与 API 一致。
- Runtime PR 尚未部署，本轮配置和工作区脚本已生效；发布状态随 PR 正文在合并部署后更新，不用测试结果代替部署证明。

本轮不声称通用终端被阶段门禁物理拦截，也不声称所有任意工具输出都能过滤敏感信息。安全输出保证适用于新增查询脚本，流程引导叶子复用它；没有改写历史会话或吊销凭据。
