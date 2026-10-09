# 当前工程任务验收场景精确绑定

## 根因与反例

仓库只有一个localAcceptance配置，创建或重建Task时直接冻结仓库最新配置。真实导入导出UAT2任务因此拿到归一化UAT3场景；生产活动结果UAT3任务拿到评审意见UAT2场景。构建通过不能代替这些业务验收。

## 最小处理

保留原Task/Run/候选/检查，新增受管local-acceptance checkpoint，严格维护排空与CAS。只允许修正冻结localAcceptanceConfig及其当前Task、环境、需求和验收条件摘要绑定，不改checks、仓库、分支和授权。原define/plan-local-acceptance含错误场景，必须重新执行这两个纯节点；保留中间已成功候选构建，不重放业务副作用。后续本地验收尚未产生effects才允许修改。Store/controller跳过已成功中段仅限此受管checkpoint，由工程代理实现。

场景脚本必须使用真实候选服务和真实业务输出，不能改场景名称冒充覆盖。导入导出覆盖PRD FR01–06：工作区/草稿全工序多Sheet、完整覆盖及错误零写、版本冲突、系统过程导出、清理旧结果和不自动重算。活动结果覆盖部分/全部失败列表、保留成功结果、下载明细、取消/继续及已有全部成功路径。准备、登录、服务、清理尽量复用现有模块；现有merge/review的业务脚本分别只验证归一化/评审，不可当以上两功能验收。

## 验证

精确匹配/跨Task/错环境/旧需求摘要拒绝；幂等与冲突；新定义保留原checks与候选；实际业务场景失败不能PASS；本地配置与真实执行分别留证round52。

后续闭环：repo.taskLocalAcceptance为精确scope+localAcceptance列表，复用已存在scope结构与runner配置。有此列表即只允许唯一匹配，不回退仓库默认场景；配置列表不参与仓库执行摘要，历史冻结Run仍须正式checkpoint。原生工程共享提示明确Task request、需求正文和锁定UAT优先于旧repair及默认场景；repair附Task真实request/criteria/UAT便于核对，不修改冻结workflow工厂。缺乏完整真实业务验收不能用前置检查替代，也不能仅按通用criteria文字推断脚本适用性。

## SG20 独立候选组件验收脚本

新增 `scripts/local-acceptance-dataset-merge-ui.mjs`，因为活动合并结果弹窗和评审草稿脚本均不覆盖数据集合并的三个步骤，不能靠更改旧场景名称复用。只编译并执行候选的 Create/BasePage/FormOne/FormTwo/FormThree、OverflowTip、手工合并状态和数据集切换 helper；保留完整真实模板、行为和 scoped SCSS。列表选择器和数据 API 为明确的 fixture 输入边界，后端写操作直接拒绝；输出固定 `backendVerified:false`，不替代实际 UAT 后端验收。

配置绑定 `task-83c651ebdbdb77584a06d1fcb6b9e255` / `uat3`，字段 `taskId`、`uatEnvironment`、`playwrightModule`、`evidenceRoot`。CLI 与既有本地 runner 相同：`<mode> --config <absolute-file>`，执行时 cwd 为真实候选目录，stdin 为 namespace/baseUrl/uatEnvironment/taskId。支持 --check、initialize、execute、cleanup、verify-cleanup。只创建本地浏览器和证据目录；拒绝重复执行及跨任务/端口账本。业务 API 实际正确性须另验，不能据 UI fixture 判为完整需求完成。
