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
