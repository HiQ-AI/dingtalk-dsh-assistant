# 原生网页读取失败对账

## 现状与根因

现场同一 web_fetch 调用在原生日志中有工具错误结果及 completed 的 turn/end，动态账却保持 unknown。execution-session 固定识别文件读取工具，但未识别当前 DSH 未提供 effectClass 的 web_fetch/web_search；task-session-service 将未分类工具错误保守记为 unknown。已有对账支持 job 和旧 shell 排空证明，不覆盖原生网页读取错误。

反例：任意写工具可能先写入再抛出错误，不能把所有 isError 改为 failed；取消、失联和仍运行的 job 也不能凭错误文本解除保护。当前安装 dsh-tool-web 的 web_fetch 只有 url 参数，经 web 服务调用；HTTP provider 使用 GET，web_search 为查询接口。

## 方案

1. 沿现有固定工具对象身份识别补入网页读取和搜索；同名后续覆盖不继承只读身份。明确的非只读 effectClass 不得被覆盖。
2. 既有 unknown 网页读取错误由现有 task_operation_reconcile 读取原生日志：核对任务/执行/会话、原输入版本与租约、callId、参数与结果摘要、原生错误结果及该轮正常结束，并确认无活动会话/job、执行已排空。只转 failed，保留原账及证明，不重放请求。
3. 新的内部账务命令再次校验当前 Owner、账摘要、执行状态和证明绑定；不增加操作人写库入口。
4. 同步 README 与已初始化实例更新 runbook。无 schema 变化，双包原生退出部署后，通过原人工申请回复让原统筹执行正式对账及续办。

## 验证与交付

针对原生网页失败、普通成功、同名覆盖、错误身份/摘要/取消/缺少结束记录，以及写效果未知保护运行定向测试。测试先暴露旧缺陷再修复；现场分别回读包、进程、健康、旧 operation 终态与原任务新执行。业务 UI 完成由原任务交付，不用插件测试代替。通过 feature PR 交付。
