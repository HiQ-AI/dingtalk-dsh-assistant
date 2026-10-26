# 收件箱处理状态与阶段计时

## 问题与目标

现有 HTTP groupSummary 剥离 topics，Observer 却按 selectedGroup.topics 判断完成，导致 routed 消息误报已处理。旧历时只取 occurredAt 到 Topic decision.updatedAt，未覆盖新 source.processingCompleted；缺少可靠 Host 入站/排队边界，不能把墙钟空窗认定为模型或锁成本。

目标：复用已存在来源、决策、通知生命周期，在真实拥有边界的位置补无正文计时；后端统一输出当前消息版本的处理状态与计时事实，前端不再猜 topics。原历史时钟不回填，不以 task 最终完成或通知送达代替语义判断。

## 设计与文件边界

- SG1：核来源续办与契约修复的远端继承及当前安装字节；定向原生回归。不无据重写已修逻辑。
- SG2：在既有 JSON 账/会话事件内记录入口、队列派发、原生 turn、Host、通知/回读实际边界。版本/request/attempt 明确关联；历史无字段为 unknown，不新增生产 SQL schema。队友负责 service/store/coordination 与只读来源 DTO。
- SG3：http.js 为每个 group 批量读取精简 messageProcessingSources；按 messageId+version 唯一匹配。优先使用新 source.processingCompleted.at；无新语义戳时按当前 Topic entry/version、processedRevision 与 completed decision 覆盖判断，多 Topic 取最大。无法证明完成的历史 routed 消息为 unknown；明确归类失败为 failed，未归类为 routing，Topic/来源仍处理为 processing。
- 输出 processingState、processingBasis、processingSentAt、processingCompletedAt、processingConclusion，以及 processingFacts（语义完成、source收束、通知独立状态、E2E适用/缺失与阶段引用）。既有起止字段保留兼容，语义解释同步README/ops。
- Observer 只读 processingState；无新字段的旧服务降级 unknown（明确 routing/failed 除外），不从空 topics 推断成功。负时显示异常，不将缺时/负时归零；可展开事实/阶段明细。保持现有表格、色彩、字体、导航，局部调整不重做整站。

## 状态与时钟边界

- completed/processed 只代表语义判断，不代表业务 Task 成功/最终完成或钉钉送达。
- source.routed 与语义完成独立；缺 source 账时不把 routed 字段当来源收束证据。
- 通知须精确来源/版本关联，ACK 不当 delivered，多通知全部已回读才可给完整E2E；无关联/缺入站/负时保留未知或异常。
- source 旧版本、同ID不同群、未完成 Topic、merged Topic、后续更新、重试/多turn不能冒充当前消息单次独占耗时。共享区间不机械求和。

## 验证计划

权威进度/goal/matrix 仅保留原任务根，本树不维护第二份可编辑目标。PR仅包含无业务消息ID的工程方案、合成fixture、测试及脱敏验收摘要。

1. 修前先运行完整Observer + React/ReactDOM + 真HTTP投影的隔离Edge：已复现 topic-pending/source-pending 都为已处理；source SHA e771c6b5221d8d698cb483a899d3f1f95db8fc21206709de75adaea8a5bb414d。宿主slot/primitives为替身，不声称完整DSH部署。
2. 定向HTTP/Observer测试覆盖旧Topic、新来源、忽略、web、多Topic max、跨夜、失败、未知、负值、修订/重复投影与通知分离。
3. 原生6项已有合同、阶段计时新增用例实际运行；skip不计PASS，首轮timeout保留不抹去。
4. 后修复跑同一真实浏览器路径：展开时钟事实、筛选、刷新、桌面/窄屏截图与JS错误/业务写入0检查；包/语法构建及测试映射校验。
5. 独立diff/隐私回查后commit+push+PR，PR正文准确列本地证据与未部署/未线上提速边界。普通开发分支不触发CI；不合并、不部署。

## 风险与反证

来源戳缺失不等于从未处理；旧Topic有覆盖完成仍可确认语义完成，但缺时不补造。source.processingCompleted早于source.routed正常，不等待新Task结束。最大历史空窗无arrival证据，不据此修改并发。无frontend-design-premium可发现技能；已读取安装的frontend-design指导，并沿用现有视觉系统。
