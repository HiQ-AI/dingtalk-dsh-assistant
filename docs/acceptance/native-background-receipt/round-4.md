# 第4轮：现场恢复与部署

1. 精确PG正常停止：stop-original-database.log；原 operation/job/会话身份保留，原 job completed/exit0，原 operation 自然 succeeded。此为进程生命周期结果，不是业务验收。
2. 原 execution 同会话续行并修正夹具：首轮5项/1错误（字符串JSON查询）；第二轮65项/1失败（固定ID断言）；cleanup-readback 夹具表0、连接0、PG端口关闭。原执行已继续修正夹具，不把这些失败改写为通过。
3. 为安装先通过现有技术申请请求原任务排空，不新建任务。maintenance-drain.json 记录原execution已drained且原操作身份不变。没有重放旧启动。
4. 首次Check零写通过，但apply在取得部署锁前因工作树不存在docs/tmp失败，服务与自启均未改；round-4/deployment/failure.json。修复脚本实际执行阶段创建锁父目录，Check仍零写，第二次Check通过。
5. 第二次部署证据在 round-4/deployment-2，包摘要与源码独立验证见 package-source.json 和 observer-package-source.json。旧进程原生SIGINT排空成功，安装成功后旧Observer manifest字节门禁误报。旧安装manifest SHA63a3d706与源码原字节完全相同；pnpm pack后的新manifest SHA9ec51b6e仅格式化，包/源码语义及安装内容核验通过；profile原摘要fc9b7dc5未变。门禁修正为显式Observer包核验。
6. complete-verified-install.ps1 零副作用Check通过后，仅完成已验证安装的启动阶段，没有重装；recovered-start.json记录新PID42240、双包摘要、profile、健康与自启恢复。独立回读旧PID不存在、18998接入和DWS就绪。初始恢复告警2，随后1，未伪记全健康。
7. postdeploy-task.json证明旧edit原生对账failed，原数据库operation及pwsh-10终态未变。resume-input.json为实际维护完成输入，resume-readback.json证明原execution同session输入版本2运行。业务全绿仍待验证。
