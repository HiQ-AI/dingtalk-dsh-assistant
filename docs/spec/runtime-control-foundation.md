# M1 控制底座实施快照

2026-09-23。依据 runtime-execution-redesign-v2；用户已明确开始实现。旧分析和现场材料保留本地，本实施文档仅含通用契约，可审阅提交。

## 范围

把M0可行性探针落实为正式模块：独占实例锁和SQLite worker控制账、固定顺序工作流、入站屏障与换代、原生Session绑定和恢复、NodeResult CAS、效果/作业账与授权的首终态。提供独立的Cordis插件服务入口，默认现有resident不加载。没有生产数据库、Git发布或钉钉发送适配器。

不复用旧store.js权威表：旧模块承担历史群/Topic/Task数据，不能混入新执行状态并形成双写。新增 execution-* 模块各有单一职责；Node/Session仍用原生DSH，业务Controller不重造AgentLoop。

## 模块与边界

| 文件 | 职责 |
| --- | --- |
| execution-store.js / execution-store-worker.js | worker RPC、有界请求、健康/未知回执、SQLite严格开库、独占锁、事务及CAS |
| execution-effects.js | 同一连接/事务内操作、授权、撤销、资源占用、job未知启动窗口 |
| execution-artifacts.js | 小型JSON输入/输出的内容寻址、落盘及读取hash校验；工件先写，权威引用后事务提交 |
| execution-controller.js | 定义校验、映射/校验节点输入输出、代码调度、进度读取、输入屏障、取消/恢复 |
| execution-session.js | 固定Session身份创建/续接、原生能力约束、结果工具、取消排空；无Goal续跑 |
| execution.js | 独立Cordis服务装配，关闭时先排空Controller再关闭Store |

## 冻结接口

`openExecutionStore({dbPath,instanceId,initialize:false})` 返回 `command({id,kind,args}) / query({kind:'run',runId}) / close()`。所有变更使用稳定命令ID；先回读receipt，再检查revision/代际/租约。相同ID不同payload拒绝；历史执行receipt不得返回新派发资格。

run.create含taskId/runId/workflowId/workflowDigest/requirementRef及固定nodes。generation初值1、leaseEpoch初值0；首节点有inputRef/inputDigest，后继初值null。node.claim事务先持久nodeRunId/sessionId、递增lease，然后才在Host创建Session。

Session创建后写原生身份事件并flush，再调用node.sessionBound；创建已成功但绑定未提交时重开同一ID、核对身份事件后继续绑定。bound且Session缺失、存在但缺身份、定义digest不符均进入明确恢复错误，不偷偷新建。恢复不自动调用模型，由Controller显式唤醒。

Controller在真实工具排空后提交node.drained。node.commit核对generation/lease/inputDigest、未决输入/stop/效果；有效output先经JSON schema校验，再映射和校验唯一后继input。输出引用、node终态和nextInput/ready在同一事务提交；上游聊天不作为下游参数。

input.accept先持久去重记录和屏障，再取消旧执行、等排空；input.apply一次更新requirementRef、变更节点和后继代际。此批按整条执行链失效，不实现字段依赖推导。用户输入去重不产生额外代际。取消同样先持久stop，再取消/排空，确认后才cancelled。

效果和job先记意图再发；unknown保留资源占用并仅允许对账。作业启动后但身份尚未落盘的窗口重启也必须unknown，不因查不到PID重启作业。生产API没有测试用fault参数。

## 能力与退出条件

M1 Controller只准入pure/read代码与显式工具清单的Agent节点；任何shell/生产外部写适配器不在本批准入。工具白名单不是OS隔离；M0已证伪本机原生读/网络隔离，后续工程脚本入口必须有独立验收过的执行环境。

通过正式模块测试、实际原生持久Session组合测试、子进程重启/控制账故障反例后，才报告M1覆盖的能力。实际HTTP认证入口、群消息迁移、PR/数据库完整业务、token/p95/长期运行、旧数据迁移和生产部署仍由后续批次验收。不得用M1局部通过关闭全部AR01—AR11。

## 提交取证

本地安装工作树依赖，执行新增定向测试及现有回归。为public仓库仅提交正式源码、合成测试、本通用实施文档与脱敏验收；不提交runtime-redesign现场审计/任务原文。PR描述列实际命令/状态/未覆盖边界，合并和部署另按既有runbook。
