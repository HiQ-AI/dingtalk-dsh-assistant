# 第三轮：真实模型工具协议与重复承接保护

## 第二根因与修复选择

真实模型第二轮正确分页并读取原Task，但连续提交空参数，未通过。`round-2-model-analysis.md` 和 `round-2-model.json` 保留失败，不能以受控模型通过替代。

确定断点：独立协调提交schema为根oneOf，当前pi-ai非strict Anthropic转换只保留根properties/required，实际变成空参数工具。不是引用仍丢失，也不是DSH把有效模型参数删掉；原生assistant、stream和tool/call三层均为`{}`。

候选验证：直接在根oneOf并列type/properties/required被实际DSH拒绝；全局改写generic schema会影响既有内部精确分支合同，未采用。最终保留 `toToolJsonSchema`，新增对象根工具投影 `toToolObjectJsonSchema`，仅生产coordination_submit使用，合并可见字段并要求kind。DSH与提供方可读该对象根；完整分支必填/互斥/语义仍在执行前由原Zod严格校验，不伪称投影保留全部原生分支约束。

## 实际验证

- `node --test test/tool-schema.test.js`：8/8 PASS。当前非strict转换保留的根字段有kind/members/question等，空参数被拒绝；有效观察提案通过，错分支由原Zod拒绝；既有嵌套schema及原生精确测试保持。
- 最终原生协调/恢复/schema/标准模型适配四文件：71/71 PASS、0 skip；冻结后发布包原生smoke再次14/14 PASS、0 skip，日志分别为本轮docs/tmp中的round3-regression.log、release-smoke-round3.log。
- 真实 `cortex-gateway/cortex-cowork high`，生产planner/context、27项合成任务目录、submit仅捕获：最终两个场景PASS，7次标准stream，真实任务写/渠道发送均0；凭据文件前后不变，费用及提供方内部网络重试未知。见 `round-3-model.json`（原始日志仅本地）。
- completed场景：真实分页20→27、读取原任务完整目标和版本，提交同原Task的task-reopen/replan，目标包含后端#417、前端#389与UAT2，没有再索要PR。
- 当前active场景：现场只读回查原任务第4轮目标已经承接UAT2；在同状态等价夹具中真实模型选择task-observe，不加context、不replan/reopen、不重复派发部署。生产指引要求重判先核当前完整目标，不能沿用原消息当时已完成的过时状态。
- active场景首次提案混入resolve字段被原Zod拒绝，模型在同轮自行纠正后提交通过；这是执行时约束实际生效，不把首稿当成直接成功。细节见round-3-model-analysis.md。

再生成：`node docs/acceptance/quoted-deployment-handoff/scripts/verify-real-model.mjs docs/tmp/quoted-deployment-handoff/model-new-round`。仅在当前既有配置/凭据可用时调用同路由；不登录、不迁移或写凭据，不连接真实业务库/钉钉适配器。

## 现场边界

真实实例仍有活动执行，最近轻量只读计数为5；不得为安装修复强停。正式双包Check在只读账本扫描中明确中止，没有向DSH发送停机信号，也没有安装包或重判#313。原任务已通过后续来源承接部署，后续恢复#313只能基于当时最新事实关联观察，不能重复部署。

PR #271 独立回读为OPEN，代码提交 `301c414dde8a66708afb0603d7596a2d95fbb226`；CI检查数0，不称CI通过。最终候选双包保存在仓库外持久目录 `D:/dsh_home/packages/quoted-deployment-301c414d/`，版本均2.2.1。独立打包检查器核验Assistant 70个文件、Observer 4个文件与冻结源码逐字节匹配：

- Assistant SHA256：`2fb2836996457ca3c212b9d3b19f3e97cb8331476d371c052c078484cfc3e627`
- Observer SHA256：`617f087d1687c79e22a82f8c5989e497def594daa7891c3b122c7d5b04ecbcf1`

最终只读轻量账本回查为3个执行未排空、5个operation处于starting；不是可停机状态。最终候选尚未执行安装，不把包字节核对当正式实例Check/部署通过。未达到正式实例完成条件，因此不生成全绿report.md。
