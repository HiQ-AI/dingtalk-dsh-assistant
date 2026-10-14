# 工作区全量迁移验收

2026-10-14按用户追加要求完成，matrix.csv本轮13项均PASS。4项metadata隔离测试通过；真实原生迁移证明在保持原task/execution/session身份、历史input/收据与native事件前缀不变时，原会话实际执行pwd及读取迁移后材料成功。

正式迁移将.dsh、task子项、session-workspaces子项共5个目录对象迁到D:\baibu-agent，同步6处当前metadata及2行数据库保护路径。3个任务会话与5个中央历史会话保原ID迁移cwd绑定，全部通过官方create/append和独立前缀摘要比对。没有直接改写native历史事件或全文替换业务正文。

正式迁移前旧PID46748已退出，端口关闭，LastTaskResult=3221225786（CTRL_C终止）；本阶段没有再向已退出进程发SIGINT，也不能据此证明此前终止的触发者。独立offline检查证明任务/执行回合均已结束、unknown效果/通知0；禁用自动启动后迁移，完整核验才启动。第一轮全局配置恢复阶段曾原生SIGINT停止PID61872，两阶段证据不能混用。

最终PID19072，GET /state/agent-config= D:\baibu-agent；原任务API session.workspaceDir/logPath均指向新tasks根。8个原生会话均可由官方只读API查询，当前工作目录0条旧根引用。源task-session-runtime-clean物理不存在，无junction/alias、无保留副本。

服务入站/消息桥正常，health=degraded的唯一项仍为18:12:14已经存在的原业务任务人工等待，与迁移无关；没有替用户答复该业务问题，没有宣称布局业务交付完成。新根部署脚本Check通过，writes=0/signals=0。

当前路径：
- Agent工作区：D:\baibu-agent
- 任务库：D:\baibu-agent\.dsh\task-sessions.sqlite
- Resident：D:\baibu-agent\.dsh\resident
- 任务及其原生日志：D:\baibu-agent\tasks\<taskId>\，原生记录在.dsh\sessions
- 共享会话工作目录：D:\baibu-agent\session-workspaces

中央DSH原生记录仍由其配置的全局backend管理；本次精确迁移了其中5条旧工作区cwd绑定及编码目录，不移动其他无关DSH历史会话。旧历史正文里的绝对路径保留为当时事实，当前header/working-directory/change和Host材料定位均为新根。

原生日志和数据完整性见metadata-migration.json、native-migration.json、migration-proof.json；在线读回见final-readback.json与native-api-readback.jsonl。本次脚本是固定实例的一次性受控迁移，不要在源根已删除后重复apply。
