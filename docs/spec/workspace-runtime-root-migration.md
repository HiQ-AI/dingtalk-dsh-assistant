# 工作区运行数据离线迁移

用户明确要求恢复D:\baibu-agent且现有任务库和会话目录全部迁移。全局配置已恢复，但taskSessions仍显式保留旧workspaceDir/dbPath、resident storage仍在旧根，须继续迁移。

分析范围：目标根冲突清单；原生持久化API create/open/append支持的元数据搬迁；会话事件摘要不改写；任务session-route.cwd、材料path/resource.path/value.image.path、store/profile当前绑定迁移。数据库内部历史input/results及回执不能直接全字段替换，否则输入/操作digest失效。

实施前须隔离验证新目录中的同sessionId+新cwd原生读取和续办，以及材料读取。不要用junction回指父目录、伪造header、改drained或清库规避约束。具体方案由源码与native API验证收敛后记录于验收plan，当前文档为开工快照。
