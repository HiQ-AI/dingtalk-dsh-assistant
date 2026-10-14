# 第二轮最终验收

## 最终实现与用户决定

- 原生任务/动态执行不设置工具白名单；readOnly标签用于调查证据关联，不能当成原生工具可见性策略。宿主权限、租约、生命周期和真实操作账保留。
- 按用户最后决定复用所属群当前职责，任务新建及续办注入授权边界、红线与回复要求；不另造重复的边界提示词。任务系统提示不使用排他的complete模式，以免覆盖原生指引。
- 未配置全局署名时保留群会话正文和署名。历史原提交已有代回尾段，格式器误删已复现；不重写或补发原通知。
- 删除Observer任务详情整个需求与控制区；保留独立创建与后端API。

## 定向证据

- 入站、回读、store、桥接等127/127（test-round-5.log）；新增早于ACK回声与恢复5/5（test-round-6.log）。
- 最终操作账和原生材料36/36（test-store-round-12.log），调查材料须匹配session、lease/input、callId、参数和结果摘要，不能伪造执行成功。
- 最终policy/native组合28项中27通过、1项受并行负载超时取消；该一次恢复用例独立重跑1/1通过且无改断言/延长timeout（test-wake-final.log）。
- 动态执行14/14、原旧节点权限/身份回归18/18；统筹/技能/同名替换等native定向通过。取消及失效租约保护继续有效。
- 新group policy真实模型请求1/1（test-group-policy-final.log）；署名/通知43/43（test-signature-round-7.log）；客户端构建/模块加载/formatter23/23（test-client-round-8.log）。
- Observer相关41/41；安装源码独立读取TaskControls不存在，不据此声称真实浏览器已经刷新。
- 部署证明1/1（test-deployment-proof-final.log）：活owner/未结束回合拒绝，死owner只读辨识且unknown事实不变。

- 最终真实打包解压运行2/2，无跳过或失败（test-package-policy-final.log）。

## 现场读回

最终Assistant包SHA256：52bf7d7afab6bb60e85283ee561344cc5770253dc37db5c294ec1343cb080759；Observer包：e078bb4f2f54af350726191e77c301b22845b65efe3c9c5b3fcc723f6da6a627。源码、包及安装49/4文件独立核验一致，版本均1.0.0。新PID63692，profile摘要21eb086e00eed66943357e14516bb1ba1b506afad2fc8c9a6d084050d1fa921b保持一致，自启Enabled=true。

health=ok，recoveryIssueCount=0，inboundProcessing=true，DWS bridge healthy=true。原通知delivered，原通知在收信箱0条；原任务及原执行身份不变，旧未知操作由原生证据对账为failed、partialEffectsPossible=true，保留previousObservation和proof，绝未写成成功。原执行输入版本2已正常运行，布局任务仍进行中。业务布局任务最终交付另属原执行，不在此报告宣称完成。

## 部署流程修正

旧maintenance不在当前运行时，原profile HMR锁又触发Windows EBUSY。最终路径仅使用经盘点的精确控制台CTRL+C触发DSH原生SIGINT。Check零写/零信号。宿主退出后可能保留死owner行；按动态库自身既有启动合同，独立确认owner进程死亡、所有原生回合结束、旧子进程/端口退出、quick_check正常，保留该行由正式启动事务接管，不手工删owner/unknown。未备份历史副本。

首轮及中间失败记录保留，最终现场控制证据位于docs/tmp/task-session-runtime-policy-deployment/readback-final.json；报告只记录摘要，不提交配置、凭据或大包。

## 边界

DWS未暴露原生mention元数据，精确发送身份、原群、发送者、原生引用与正文齐备时只确认送达，mentionVerification=unavailable。无精确回执或明确错误元数据仍拒绝。不额外发群消息验收署名，不把组件测试当浏览器现场验收。
