# 第 20 轮：首次领取执行时钟与真实重放

## 修复

首次成功领取模型节点才建立执行时钟；维护与领取前排队不消耗执行窗口。旧账从真实节点领取时间推导执行年龄，不重置已消耗预算；无真实模型领取的旧超时经正常恢复继续处理。已独立回读的纯状态通知，在没有业务命令时允许受控重处理，原回执保留；未知、发送中、仅ACK及业务效果仍拒绝。

## 本地验证

- 三组相关测试148/148通过，最终语义收紧后定向5/5通过。
- 精确Assistant包99文件与源码一致；Observer沿用已验证4文件包。摘要见round-20-packages.json。
- 维护revision160，nodes/owners/effects/messages均0；零写部署预检通过。
- 扩大集成、正式部署和真实重放结果待独立回读补入，不以打包或预检代替完成。

## 本机原始证据

敏感原始消息、回执及模型输出仅保存在docs/tmp/message-processing-deploy/；公开记录仅包含必要状态与测试结论。

- 扩大集成：node --test --test-concurrency=2 test/message-ledger.test.js test/message-impact.test.js test/workflow-service.test.js test/http.test.js test/workflow-notification-obligations.test.js；287/287 PASS，0 fail、0 skipped，156975ms。

## 正式部署回读

- 备份：owner-repair-20260930-212722-637；安装助手99文件、看板4文件全部匹配精确包。
- 新PID36252；health=ok、recoveryIssueCount=0，认证Web303/200；旧22 Task、76历史节点、29终态Run、68旧任务摘要全部一致。
- 维护期经官方接口重处理#114至来源版本4；#111版本2、#113版本3和#115版本3保持。Resume后maintenance revision162、active=false。
- 首次恢复回读：#115保持原版本从无节点超时恢复pending，S及R已有真实成功节点；#114尚在排队且没有提前失败。最终任务与通知另行核验。

## 真实重放反证

- #115在原版本恢复后完成R关联；其一次非法JSON响应由既有重试恢复，判断持续推进。
- #111/#113经IB分别产生只读answer，但pending且leaseEpoch=0；唯一阻挡来自#114的旧独立证明。IB新增约束使topic.contextRevision从4增为7，旧证明失效，属于守卫按新事实等待，非相互自锁。
- #114一次模型调用超时后等待调度，随后进入MESSAGE_DEADLINE_BEFORE_CLAIM:R:<unit>。已有模型节点不满足第20轮首次领取恢复条件，证实重试排队仍被误算执行窗口；A14仍FAIL。
- 已通过正式接口进入维护revision163并排空，准备同因闭环修复。未清库、未强制放行，已关联结果和已送达通知保留。
