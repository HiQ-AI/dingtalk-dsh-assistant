# DSH 联合升级验收结果

2026-10-13 当前 Web profile 的兼容升级、受控重启和恢复完成；[逐轮矩阵](matrix.csv)的各用例以最新轮为准通过，历史失败和未覆盖边界保留。

- 已安装：DSH0.2.1-alpha.2、Cordis4.0.5-alpha.1、Loader1.0.6-alpha.1；Connect0.2.0-alpha.3本地alpha2适配包、Assistant/Observer1.0.0、Convergent0.2.1-alpha.2-convergent.1、Bytebase0.1.0适配包，插件市场未恢复。
- 已启动并恢复：同一新PID39344，3080/18998同进程；13:33:11 UTC延迟回读healthok、inboundtrue、Bridgehealthy、recovery0、maintenance inactive revision773。8 task、47旧node、27旧run及安装文件独立核验通过。
- 包与历史：10本地包/5迁移包及实际main/worker通过；81v0源字节保留，24488事件/82owned身份、range/generation、真实writer flush/reopen与严格反例通过。完整版本/摘要与命令结果见[round-7](round-7.md)，历史专项见[round-4](round-4.md)。
- 页面：正式真实认证、Assistant设置、Observer数据及实际检查项展开/折叠通过；0非预期console/pageerror，无synthetic/CORS代理。provider注册、默认gpt-6-sol/low、4preset原生诊断通过；Connect保持signed-in，认证文件摘要未变。
- 并行设置：采用当前配置新基线，不覆写他人工作。117旧输入/135新证据链通过；欢迎确认的完整语义差异仅版本号。初始写者未证明、旧prefix未恢复，不能宣称所有旧配置不变。一个无消息的空初始化验证会话留存，原生没有delete Remote。
- 源码：根仓[PR170](https://github.com/HiQ-AI/dingtalk-dsh-assistant/pull/170)、Bytebase[PR3](https://github.com/HiQ-AI/dsh-bytebase-mcp/pull/3)均OPEN且已独立回读；正文区分实际安装、恢复与业务验证，见[round-8](round-8.md)。未合并或发布公共上游。

未执行真实模型请求、Bytebase外部OAuth/SQL或钉钉发送。Bytebase正式service登记未直接取证；Convergent constructor identity由完整原生策略隔离profile验证，正式层证明配置与原生诊断。Connect完整Windows check仍有既有平台/canary失败，定向和本次alpha2 API验证通过，不能宣称全量绿色。完整私有数据留本机，不提交。
