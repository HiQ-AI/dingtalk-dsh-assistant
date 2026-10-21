# 第一轮：方向职责与决定历史

## 实现与机制验证

统筹指引已覆盖最新整体目标、受托目标、范围/授权、验收条件、前置依赖及当前动作的推进价值。首次确认偏离即可向原执行反馈，后续以实际动作核查落实；人工等待和十分钟计时规则保持。

决定历史复用不可覆盖的命令收据，同事务保存完整决定及关联唤醒，增加部分索引和按任务游标分页。原始日志继续保留。升级前无 taskDecision 结构的旧记录不猜测补录，查询边界已在 README/API/runbook 明确说明。

- `pnpm install --frozen-lockfile`：锁文件未变，工作树物理依赖可用。
- `node --test test/dynamic-task-store.test.js test/task-session-progress-native.test.js test/task-session-http-integration.test.js test/task-stage-progress-native.test.js`：104/104 通过，0 跳过。见 `round-1-tests.log`。
- 补齐人工申请的 audience/attemptedActions 留存，并加入收据失败回滚用例；随后同组加 `test/task-session-package-native.test.js`：107/107 通过，0 跳过。见 `round-2-tests.log`。
- 覆盖连续判断、原文/证据/限制保留、同请求幂等、异内容拒绝、任务隔离、分页中插入新决定、完成及人工介入、对话回复、重启、事务失败后安全重试。
- 包测试从真实 tarball 解包并启动隔离 Resident，验证健康及个人技能路径。这不是本机活动实例部署证据。

## 真实模型验证未完成

使用生产 createTaskSessions、当前 gpt-6.1-sol 和已安装 Connect，在隔离目录提供合成日志与目标；所有模型可执行工具限定为读取、原执行合成反馈及决定提交，不接触真实任务或业务资源。脚本在 `scripts/evaluate-model.mjs`，参数显式传入输出目录、Connect 入口、模型、代理 URL。

第一轮直连的八项均在模型调用阶段返回 TASK_SESSION_PROVIDER_TRANSIENT，actions 为空。核对现场 Connect 配置后，第二轮改为同一现有本地代理；首次场景仍 fetch failed，脚本已改为遇该故障停止余下场景。独立 Node/undici 探测得到 UND_ERR_CONNECT_TIMEOUT（目标 chatgpt.com:443，10000ms）；未修改登录、代理或活动 Host。

这两轮没有产生模型方向判断，不能作为识别率通过或失败的证据。原始测试会话保留在本工作树 `docs/tmp/task-progress-steering-model-round-1/` 和 `round-2/` 对应目录；它们不进入 PR。真实模型语义评估在 matrix 中为 BLOCKED，不能用确定性适配器测试替代。

## 交付边界

运行时职责直接写入插件，未新增重复 skill。没有改人工等待，没有重放或接管真实任务，没有发送钉钉消息，没有触发 CI，没有更新当前安装实例。
