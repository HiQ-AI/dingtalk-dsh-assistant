# 插件性能与协调流程优化

> 状态：ACTIVE
> Goal ID：performance-flow-20260921
> 最近维护：2026-09-22T09:48:00+08:00
> 权威目标：D:/project/dingtalk-dsh-assistant-performance-flow/docs/acceptance/performance-flow-optimization/goal.md

## 总目标

实施 docs/spec/plugin-performance-flow-plan.md：停止确定性故障空转、准确计量、缩减输入与结构返工、提供准确检索位置、隔离请求上下文，验证后用中文 PR 交付。

## 完成条件

- 全部子目标落实或对外部依赖给出已复现的具体阻塞，不能静默跳过。
- 本地实跑、授权/版本/重启反例、固定样本验证有独立证据。
- PR 已提交并回读；真实流量性能目标与本地测试分开，不以模拟测试声称实际提速。

## 范围与约束

- 原主仓保留原样；仅修改本隔离工作区。无真实历史群发、审批、部署或业务写入重放。
- 保留全部适用规则、语义审查和授权；不靠增加并发/timeout规避问题。
- 按既有结构复用，必须新建时说明单一职责理由。

## sub goal matrix

| ID | 子目标 | 完成判据 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| SG1 | 故障止损与恢复 | 同错无空转、重启不解除、版本/授权失效拒绝恢复 | 本地集成验证完成 | runtime-integration-4.log：132 PASS；runtime.js retryTaskReport |
| SG2 | 正确性能聚合 | usage/首流/等待可复查，seed/replace不重计 | 本地集成验证完成 | performance.js；test/performance*.test.js；README观测缺口 |
| SG3 | 紧凑输入与材料复用 | 路由目录减量、关联历史不漏、可见性失效正确 | 本地与离线投影完成，人工语义待补 | topic-runtime.js；81条人工路由真值未完成 |
| SG4 | 结构错误一次反馈 | 多错误集合、失败零副作用、版本反例 | 本地集成验证完成 | topic-model.js；test/topic-runtime.test.js |
| SG5 | 工作位置与检索 | 复现历史检索参数、准确路径传递、工具责任明确 | 部分完成，外部包未部署 | search/report.md；22条改善；8无前缀及4宽目录未解决 |
| SG6 | 请求级协调会话 | 角色/请求/群隔离、资源释放、恢复幂等 | 本地与原生验证完成 | round-9-tests.log：514 PASS；原生生命周期6项、manager4项 |
| SG7 | 集成回放与交付 | 全量测试、固定样本、中文PR与状态回查 | 已合并并本机安装，真实流量收益待验 | PR #113 merged bfe3994；本地安装文件哈希一致 |
| SG8 | 新分区计量写入故障 | 原生Domain首次写入成功、复启续写，健康状态恢复；不重放消息 | 修复已本地验证，待PR/部署 | round-10.md；515 PASS |

## 当前检查点

- 当前子目标：SG8
- 唯一下一步：提交SG8修复PR并部署；切换前确认业务会话空闲，安装后验证新分区持久化和健康恢复。
- 未闭环项：81条消息人工真值与首次实质回复标注；责任包发布安装及12条宽范围搜索；真实流量性能目标。当前不部署。

## 进展

- 2026-09-21：读取原方案及当前安装/源代码；fetch后基于origin/main fd8fa15创建worktree-performance-flow，复制前置设计与完整清单模板。

## 重大决策

- 现有止损、增量决策与可见材料复用优先补验，不重复造机制。请求隔离作为单独子目标验证。
- 原审计目录包含本机业务数据；不复制原始指标文件到提交。只导入必要脱敏固定样本及摘要。

## 重要信息

- 仓库：https://github.com/HiQ-AI/dingtalk-dsh-assistant；base=fd8fa15，branch=worktree-performance-flow；PR #113 OPEN/DRAFT，base=main，源码已推送SHA=da347869e252abf3f90fb04fe425284749e366da，worktree保留。
- 原方案：D:/project/dingtalk-dsh-assistant/docs/spec/plugin-performance-flow-plan.md。
- 本机运行：D:/dsh_home；本轮部署须在源码与本地验证闭环之后单独决定，当前未部署。

- 2026-09-21 22:30：请求级会话、恢复预检、紧凑输入、结构问题集合、只读性能API和准确路径已落地；runtime第4次集成132 PASS，前3次失败日志保留，最终全量与原生集成仍在执行。
- SG5上游独立仓 D:/project/deepseek-harness-search-performance，官方基线 dsh-v0.1.2-rc.1，分支 feature/glob-fixed-prefix-pruning，本地提交884bafd6589862a2ea14499adbaeb5dbc198771e；未推送、未安装，补丁在search/。
- 2026-09-21：README及既有本地部署runbook同步，三份完整清单逐行保留状态/理由/证据；有缺口的项保持PENDING，未生成总体验收全绿report。

## 本轮决策补充

- 搜索优化使用同cwd下目录专用glob剪枝，保留原pattern/root和空结果语义，不把timeout加长作为修复。
- 指标只统计已观测事件，公开缺失计数；不回填旧日志、不以首流事件代替首次实质回复，也不承诺未核验费用收益。
- 请求资源读取限制为本请求明确引用的身份和可核验完整内容；不因完整读取受阻开放工程写工具或猜测原文。
- 尚未完成的生产包安装、真实流量对照与历史人工标注保持独立未验证边界。

- 最终本地代码：第9轮514/514通过；Web构建无差异、三包再次打包并独立读回。原生反例修复工具结果释放竞争、claimed消息丢失和创建期路由优先。
- 本轮准备以草稿PR交付已验证代码；人工语义真值、真实供应商/渠道E2E及整体检索超时率未达标，验收目标保持ACTIVE，不假收敛。
- 离线固定样本：91批覆盖81消息；同快照路由content P50 32310→11021B、P95 34971→13748B；目录续页次数不变。仅结构/体积验证，不替代人工语义与实流量。

- 交付回读：PR https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/113，OPEN/DRAFT，head=da347869e252abf3f90fb04fe425284749e366da；远端分支SHA一致。原生CI手动触发：https://github.com/HiQ-AI/dingtalk-dsh-assistant/actions/runs/35615780197。

- 原生 CI 已回读 success：run 35615780197，源码 SHA da347869e252abf3f90fb04fe425284749e366da；构建、测试、三包打包及上传均成功。产物 npm-packages-da347869e252abf3f90fb04fe425284749e366da，id=10646272483，228177 bytes，未过期。此后提交仅更新交付文档，不冒充CI已测试新文档SHA。

- 2026-09-22：用户反馈今日消息已投递却似无响应。只读核对：两条相关实质回复先后于09:46:37和09:47:08由Outbox送达并有deliveredMessageId；代理接收与群回复间存在数分钟排队/处理。另发现性能投影新分区调用update导致原生Domain报no record，健康降级；mock错误容许upsert而漏检。新增原生回归，修复为put，515项本地通过；未重放消息。
