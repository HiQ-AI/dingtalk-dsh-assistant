# 第 9 轮：修正原生安装入口并接续原通知核验

profile 声明本地完整运行时，原部署脚本却硬编码 profile node_modules 中的旧平铺 CLI。只读 plugin --help 复现旧入口 ERR_MODULE_NOT_FOUND；声明的完整运行时入口同命令 exit0。永久修复改为：停机前校验声明与已安装宿主版本一致，并用实际 profile CLI 检查装配，禁止普通代码部署隐式切换宿主。PowerShell AST 无语法错误。

本轮先零写核验原 install 失败现场、精确旧 PID69116 不存在、双端口关闭、自动启动禁用、原包与 profile SHA256 不变、46 个会话离线排空及 unknownOperations=0。Check 输出 writes=0、signals=0。持原部署锁只接续原安装阶段，使用同一组持久包与配置声明的原生 CLI；不重新停止进程、不改任务数据库、不调用消息发送接口。

原安装阶段接续成功：Assistant 2.0.2 的 54 个包文件和 Observer 的 4 个包文件核验通过，profile patch SHA256 不变。但首次启动仍因当前 profile 缺少声明宿主的必需 peer 依赖而失败，未达到运行态验收。原通知仍 unknown，sendAttemptCount=1。round-10 按宿主真实依赖闭包补齐23个必需peer，不改自动安装策略。本机细节在 docs/tmp/notification-receipt-deploy，完整业务配置和正文不入库。
