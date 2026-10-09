# 第27轮：工程准备与原生 provider 错误恢复

## 根因证据

- 生产活动原Task准备阶段 Git 128：配置的 `D:/dsh_home/workflows/runtime-v2/sources/dataset-web` 当时缺失，首条 `git -C <source> check-ref-format --branch feature/uat3-base` 即失败。配置 remote 为 `https://github.com/HiQ-AI/dataset-web.git`，baseRef `origin/main`；未发生工程Run。源仓库恢复由主代理操作，不属于本轮测试。
- 数据集原Run `run-8fd2d5775eca1d446eb3fd72f2f881db5132b52326ebcaa06d949d585e37283c` 的原生session `07ec1d2c-b11f-4956-ad7d-565283baefd0`，seq79/90均为 `turn/end` provider `PI_AI_ERROR`，首行精确表示 Codex 服务过载。旧适配器未保留结束原因，误记 `execution_no_submission`。最后本轮 user/message seq85，lease2，end seq90。
- 只读新谓词实跑现场JSONL：`eligible=true, lease=2, inputSeq=85, endSeq=90, code=EXECUTION_PROVIDER_TRANSIENT`。现场Task业务状态active、stage running、control active；Owner block不是业务暂停。

## 实现与边界

读取本轮原生结束原因，提交已接纳时优先返回结果；仅精确过载白名单走持久退避，按同run/generation/node/input/problem最多三次。缺源在Git与工作区动作前报明确环境错误。

历史未提交仅通过Host只读验证原生身份、租约、最后输入、无额外输入、无提交和无活跃注册后生成审计artifact；`node.failure.reclassify`保留旧事件并CAS当前run/node/session/input，检查排空、节点零效果、任务来源、维护及控制门禁。随后原恢复扫描重领同Run/Session，不新建Task、不伪造用户输入、不删除旧node.resume限制、不重放成功节点。SDK持久化读取与存活注册判断只读，不dispose其他所有者。

## 本地验证

- `node --test test/execution-session-native.test.js`：41 PASS。含provider当前轮分类、跨轮不污染、已提交优先、历史身份/租约/额外输入/活会话拒绝。
- `node --test --test-name-pattern='旧未提交错误|provider暂态恢复|工程源仓库缺失|旧provider未提交' test/execution-store.test.js test/workflow-engineering.test.js test/workflow-service.test.js`：11 PASS。含持久退避/三次上限、CAS漂移/已有输出/未排空/已有节点效果拒绝、缺源零副作用、真实service控制账贯通同Run同Session恢复。
- 日志：`docs/tmp/sg13-native.log`、`docs/tmp/sg13-engineering-tests.log`。未执行部署或live恢复，本地测试不代表线上任务已恢复。

## 第27轮现场仓库恢复

配置的dataset-web源目录不存在，已按现有准入恢复独立完整clone；origin=https://github.com/HiQ-AI/dataset-web.git，main=59f3a7eb320af08baa1b18510549c942be2610d5，origin/feature/uat3-base=a3a2f641044d718f1cb7f05db86a9727a3052524。独立读回工作树干净、非浅克隆、.git为目录且无alternates；未触碰用户旧业务检出。

沿reassess-readonly对原Task使用当前Owner/需求/控制版本提交，后续独立详情显示计划1、stage1 running，prepare-generation/define-local-acceptance/plan-local-acceptance/prepare-workspace均succeeded，inspect-and-propose进入running。随后反馈人新补充消息在另一Task上遇TASK_CONTROL_CONFLICT，暂持有消息屏障；后续结果单独记录，不把此快照当最终业务交付。
