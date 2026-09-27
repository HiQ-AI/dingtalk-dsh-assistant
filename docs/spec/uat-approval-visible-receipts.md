# 审批事件与 UAT Web 请求可见性

## 现场原因
审批 requestId 使用 external 加 64 位摘要，Owner 事件再拼接完整 requestId 与 64 位结果摘要后超过 128 字符限制；审批已落账且部署已运行，HTTP 却因 Owner 事件拒绝而报错。审批列表仅接受 production/data 且要求 IM 群来源，排除了实际存在的 Web UAT 请求。

## 修复范围
事件键对审批身份和持久终态做固定长度摘要；事件载荷不包含每次调用会变的 applied 标记，重复或相反重复决策复用同一事件。正常授权、首终态生效和失败传播保持不变，不捕获并吞掉任意 Owner 事件异常。

列表复用已有 readableTaskOrigin；仅增加原生 uat-deployment/uat-rebuild 构建操作的批准请求，读取已冻结目标说明 UAT 环境、项目、提交与动作，Web 来源使用 Web 请求文本。展示不等于授权，审批仍使用原 approveIds、Web 身份、任务来源门禁。

## 验证
临时真实控制账中，用完整长度 external requestId 验证批准回执、Owner 事件只产生一次、相反重放不改变终态、不越权；验证 Web UAT 请求可见、不可读来源仍隐藏、拒绝不派发。
