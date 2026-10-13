# 工作流与配置管理验收报告

源码、接口、隔离原生运行、真实浏览器与打包验证已通过。matrix 按每个 case 的最大 round 取状态，最新 91 项全部 PASS；历史失败保留，不代表全量仓库测试或正式部署全部通过。[PR #167](https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/167) 已独立回读为 OPEN / MERGEABLE，main ← worktree-workflow-dashboard，尚未合并或部署。

运行看板新增「工作流」与独立「配置」Tab，支持目录/节点/维护依赖/任务跳转，以及普通 text/JSON、凭据、版本冲突保护、启停和工作流别名绑定。凭据写后不回显，旧任务保持冻结版本；重置新 Run 重新冻结，预览与重复请求不重复冻结。

持久化复用原生 credentials grant record，按 instanceId 隔离；Host code reader 和工程 v26 的已授权托管只读数据库入口真正消费配置。原生会话工具链证明源 JSON 移动、Host 重启及 reset 后读取正确版本，Owner/失效租约/缺授权失败关闭。配置内容与秘密不进入模型或执行工件。

最终基于主线 f1487e0 集成：UI/API/启动/合同字节 133/133，原生消费等 23/23、关联主线回归 23/23；浏览器配置 16/16、目录与导航 36/36、任务关联 24/24。见 [round-25](round-25.md)、[运行证据](runtime-verification.md)、[后端证据](backend-verification.md)。

固定 f148 发行基线的 v25 定义由当前源码恢复，16 节点摘要一致、持久化写 0；v26 三种工具登记及重启场景通过。旧 446 本机全 CRLF 夹具在主线发行混合字节下被拒绝，已用同 record/同 factory 的仅字节对照定位，不修改旧 expected、不放宽摘要校验，不承诺全部历史组合均兼容。见 [历史定义验证](historical-definition-verification.md)。

三个 1.0.0 包已经生成，包内 128 个 JavaScript 与 3 个 Markdown 逐字匹配当前源码/文档；详细 SHA 和生成配方见 [打包核验](round-25.md)。没有安装或部署这些包。

边界：默认 credentials-local 在磁盘明文保存，Web 脱敏不等于加密；旧平台 secretsDirectory/kubeconfig/Spring 等文件未自动迁移。数据库与模型使用隔离替身，未验证正式数据库连通、真实模型自主交付、钉钉消息或完整发布。回退旧插件前须先处理新 v26 活动任务；保留配置记录与冻结历史，不能依赖旧版本自动恢复新定义。
