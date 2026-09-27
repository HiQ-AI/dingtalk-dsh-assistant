# 受信运行资源查询扩展

补齐共享查询中的真实UAT部署/配置/日志来源。复用query_runtime_status注册与scope授权，新增受信kubernetes资源种类；不新建任务调度。固定Host kubeconfig、server、namespace、deployment；模型只能传resourceId。只调用get deployment/replicasets/pods及精确归属Pod的限量logs，禁止exec、配置写入与Secret读取。部署证据保存资源版本及实际镜像ID；运行配置只取副本数、端口、资源请求/限制，不输出env、Secret、完整YAML。日志只提供时间窗口、行数、ERROR/WARN与异常类计数，不输出任意日志正文；明确不能代替完整业务根因分析。服务端无GET JSON健康时不冒充健康，Ready只证明K8s就绪。使用固定原生命令、有限时限、输出上限、AbortSignal；错误只固定码。真实读验证写docs/tmp脱敏证据，不更新正式profile。数据库不接入。
