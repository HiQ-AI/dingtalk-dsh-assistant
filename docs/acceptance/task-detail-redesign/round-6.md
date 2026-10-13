# 第六轮：组合回归与独立复审

2026-10-13。

## 已通过

- 浏览器23/23通过，完成与未计划截图语义已修正；docs/tmp/task-detail-redesign/round-6/browser-results.json 与同目录截图。源码 SHA256 为9320c8a6b07ff8cd0b4158ea35bf956f782371cca9cd6d6213aab3e77596c47f。
- Service 定向10/10通过、0跳过：`node --test --test-name-pattern='Owner 在零阶段|零阶段任务执行中|任务详情和历史执行 API|当前完整详情' test/workflow-service.test.js`；日志 docs/tmp/task-detail-review/service-associations-round-3.log。
- Service覆盖直接完成/处理中/未绑定Owner及取消，Agent绑定成功/失败，新generation换会话与产出但保持阅读身份，真实Owner接管提交后两会话分别归属，同阶段替换实例与planned→started身份，需求变更与一致性快照。
- 真实双仓 v25 回归：`node --test test/engineering-v25-checkpoint.test.js`，1/1通过、0跳过、234312ms；新增checks/local checkpoint两次修订均保留成功前缀stepKey、节点、产出与会话。测试使用临时本地仓库/受控HTTP/模拟PR回执，不能当成线上交付。
- Assistant/Observer两包生成，尚未以本轮包作为最终交付，因为独立复审发现以下问题。

## 独立复审发现

新增隐藏时保留焦点后，任务A隐藏期间删除选中步骤，再直接从其他页面打开任务B，会把A的删除提示残留到B。实际异步effect片段复现：B详情和选中项已更新，但notice和pending focus仍属于A。矩阵 cross-task-notice 记 FAIL。

修复方案：接纳详情时清除其他任务或其他物理执行遗留的焦点目标，并清除旧提示；同任务隐藏期间仍保留。新增异步回归及从归档卡片直接打开另一任务的浏览器场景，验证另记round-7。此处保留失败，不用本轮23项通过掩盖新发现。
