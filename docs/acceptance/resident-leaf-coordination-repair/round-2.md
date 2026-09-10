# 第二轮：交付与部署

2026-09-10。代码验证：`pnpm install --frozen-lockfile --prefer-offline` 成功；`pnpm test` **391/391 PASS**（all-tests-round-5.txt）；Web Client 构建后 `git diff --exit-code` 无差异；`git diff --check` 通过。

真实模型、磁盘接纳和重复内容重放详见 performance-measurement.md、round-1.md 及对应 JSON。真实模型样本只覆盖独立 LLM 往返，未验证群消息端到端 SLA。391 项测试包括持久报告恢复、原生 Loop 停等、同版本状态变更、关联集合/职责 CAS、活动心跳隔离、重试耗尽原身份恢复、旧阶段索引两次重启幂等。

## 已完成的配置更新

通过原有 `/config/agent` 以总版本 3 作 CAS，只提交任务流程库。总版本回读为 4；生产发布流程 revision 2→3，数据变更流程 revision 1→2。更新前确认活动任务引用这两个流程的数量为 0。其他配置逐字段相同。证据 workflow-config-readback.json。正文尾部换行由 Store trim 规范化，离线脚本已同步，不重复发送配置更新。

## PR 与安装

准备 feature PR 和唯一打包目录；未合并、不发布 npm 新版本。安装前仍需核实两个活动业务任务的执行状态、稳定存储备份与读取预检。后续回读追加在本节，不把包构建或接口健康当作真实业务验收。

## 未验证边界

- 真实钉钉群投递和客户端显示时间：未发测试消息。
- 真实生产 SQL/部署业务 E2E：未重放。
- 原生重试在真实故障下恢复：新模型测量没有触发重试；分支由确定性错误注入覆盖，前轮技术失败保留。
- 新版绑定候选编号的合成模型 fixture 仅做 `--check`，已测历史结果使用旧 fixture，身份歧义已披露。

## PR/CI/产物回读

PR #91 OPEN，源码提交 0abe712b72daf07aa661766662fcde189703ce07；GitHub Actions 34461854317 success，测试、Web 构建一致性与三个包构建通过。Assistant 本地包 131871 字节，SHA256 3C24696EAED29C15FFAEC7B3C0C93B9BE8ADC0BD4F129AC7D250B894638A52BA。仅安装 Assistant 的候选，Observer 保持不变。详见 delivery-readback.json。当前两个业务任务运行，已提出切换时机问题；尚未重启。

## 本地切换完成

用户明确允许现在重启并短暂中断现有任务。停止已核实的旧 PID 408752 及其两个 DWS 子进程，确认两端口释放；稳定 v7 存储 7656368 字节备份在仓库外，独立 SHA256 相同，预检无非法记录/字段剥离。原生 CLI 安装 0abe712 对应 Assistant tgz，25 个源码/patch 文件 SHA256 全匹配；package.json 唯一差异为打包移除末尾换行，已据实修订 runbook。Observer、其他依赖及 profile patch 不变。

新 PID 374340 同时监听 3080/18998；health 为 ok、inboundProcessing=true、recoveryIssueCount=0。配置与切换前修订后内容 deepEqual，通过。44 个任务保留，两个活跃旧任务各补齐一次阶段索引；原 Session 恢复，其中一个已出现新模型工具步骤，另一个恢复后进入 compaction，未将其声明为业务完成。启动后存储预检仍无字段剥离。

认证入口和携带会话 Cookie 的根页面均 HTTP 200，标题 DeepSeek Harness，页面包含模块脚本。内置浏览器访问本地地址报 ERR_BLOCKED_BY_CLIENT，因此视觉交互检查是 UNKNOWN，不将 HTML 返回视作渲染通过。真实业务群投递与生产操作未做测试。脱敏证据 local-deployment-readback.json；原始配置、日志、凭据与业务备份未提交。
