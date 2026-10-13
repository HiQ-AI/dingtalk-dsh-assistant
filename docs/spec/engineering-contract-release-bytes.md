# 工程合同发行字节与本地部署恢复

目标：将最新主线部署到本机，保持现有工程工作流的冻结身份与成功历史，不改持久定义、不放宽恢复校验。

当前受控部署已停旧实例并安装 main 316b491 双包，但新实例启动在 workflow-engineering.js 的历史成功 Run 恢复处报 ENGINEERING_DEFINITION_DRIFT。profile 前后 SHA 相同，仓库配置摘要门禁已通过；配置恢复提案不适用。

已查到 engineering-output-contract.js 与上一正常发行包规范化内容相同，原始换行字节不同。三个 validator 的 Function.toString() 参与 task-workflow.js 的嵌套 rulesDigest；当前 .gitattributes 未保护该文件。外层定义规范化不改变已经生成的嵌套摘要。

实施前需用只读持久定义回放证明该差异导致摘要漂移，并证明恢复原发行字节后精确匹配。确认后仅恢复该文件原字节并添加 -text 约束，补充针对真实 Git checkout 的冻结 validator 摘要回归及 README/runbook。源码逻辑不变。

验证：旧/新字节归一化一致；修复前失败/修复后通过；相关工作流合同与定义测试；干净 Git checkout 的 validator 摘要与受信发行值一致；新唯一包 SHA 与本分支源码匹配。使用原 launch 收据的 RepairStoppedLaunch 先 Check 再安装，继承已安装 Observer；随后独立包/PID/健康/旧接口/真实浏览器验收，Resume 后确认派发与 DWS 健康。

边界：不改业务数据、配置、历史 workflow digest 或原部署收据，不调用远端表格和外发消息。主检出已有未提交文件保留。
