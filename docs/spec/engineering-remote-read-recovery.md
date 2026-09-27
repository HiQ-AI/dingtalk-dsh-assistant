# 工程远端引用读取暂态恢复

## 原因
工程模块统一 Git 子进程超时为 15 秒。verify-candidate 的只读 ls-remote 超时被原始 execFile 异常传播，code=null 后退化成 NODE_EXECUTION_FAILED，丢失明确暂态语义。冻结候选和冲突检查已完成，尚未开始构建。

## 最小修复
仅 ls-remote 走三次有界只读重试，每次仍为 15 秒，间隔 250/500 毫秒。仅明确 timeout、连接重置、暂态 DNS/TLS/HTTP 5xx 允许重试；认证、权限、证书、仓库不存在、可执行文件缺失等立即失败。成功输出仍走原精确 ref/SHA 校验。持续暂态抛 ENGINEERING_REMOTE_READ_TRANSIENT，进入原三次持久化退避恢复；永久失败用安全明确错误码，不泄露远端或凭据。push/fetch/commit 等命令不走新重试逻辑，不修改冻结配置或规则摘要。

## 历史 generic 失败恢复
不把 NODE_EXECUTION_FAILED 加入通用暂态白名单。只对已独立核实为这一次 ls-remote timeout 的具体 run/node/input，确认节点排空、无未知效果、无停止/暂停/待处理输入、工作区及冻结候选仍一致后，通过正式维护下固定范围的原生 controller/store run.recover 恢复同一节点。保留原失败工件，不直接更新 SQL；新代码负责后续明确的暂态分类。

## 验证
注入只读 exec 和 sleep，断言暂态后成功、有界耗尽、认证/权限/缺分支不重试、不接纳写命令、错误不暴露 stderr；现有 service 定向恢复测试确认新错误码适用持久三次上限与维护门禁。
