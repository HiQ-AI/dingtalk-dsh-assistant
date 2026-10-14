# 三项修复联合验证（2026-10-14）

共同基线为 `1f10eea10aa26a1afc2e08ec9d0d842925b38bd8`。在隔离分支合入 Issue172 内容索引、整体进展与非终结阶段报告、Provider/background 恢复三份补丁；三份原始文本的字节数与作者 SHA256 均匹配。

共享 `execution-session.js`、`task-session.js`、`task-session-service.js` 逐处合并，保留内容读取、阶段报告回调和 Provider 恢复上下文。联合测试发现执行投影遗漏阶段证据、恢复决定及租约身份；补齐有界当前字段，完整结果仍通过内容引用读取。保留 `lastDecision.at`。旧原生脚本模型通过真实 `model_content_read` 核对完整结果，原证据与人工等待断言保留。

最终实际运行 33 个相关文件：**541 通过、0 失败、0 跳过、0 取消**。采用 Node 24.19.0、PowerShell 7 和按仓库 resident 声明安装的独立原生测试 profile；真实原生 Loop/Tools/JSONL/SQLite/shell/job/preset 生命周期，仅模型 adapter 脚本化。覆盖三修复同场景、32轮投影/持久化、阶段报告继续执行及人工门禁、Provider预算/冷却/新输入、v12原始错误、legacy恢复、后台job、HTTP和真实包/构建。

真实 Chromium/React 页面 fixture 验证 **26 场景通过**，桌面1440与窄屏390，每状态4次刷新及展开记录，下方控件最大位移 **0px**；0页面错误、0外部请求。前端严格静态审计0项发现。fixture不等于真实宿主或钉钉现场。

完整联合补丁、29个源码/测试/文档文件、逐项541条测试清单、最终及过程日志、浏览器脚本与SHA清单已保存 Library：`libfile_2c459a61766881919a903f47b53e9afe`。原交接ZIP SHA256为 `b95c8a294e8930645c1462242aef3da1d2f893c7c7b6629a9abb95b14dcfadb2`，联合补丁 SHA256为 `d4ca1a8d0bb6a8cabfc4e38c3b12b6e64555bdde8388e34cdee10dcd4a5822f6`。交接补丁在干净共同基线archive检查/应用通过，29文件与验证工作区逐字节一致；此后仅追加本验收记录并同步 README 后台说明。

这不是 GitHub CI 或现场恢复证明。Issue172旧现场SDK迁移日志错误仍未核验；真实provider、原业务任务、钉钉通知、Windows实际部署与重启读回均未执行。不自动关闭Issue，不修改现场会话或人工请求。已初始化实例更新须遵循 [清洁启动 Runbook的更新核验](../ops/task-session-clean-start.md#已初始化实例更新核验)，保留原数据库/身份/epoch/会话，不重复初始化。
