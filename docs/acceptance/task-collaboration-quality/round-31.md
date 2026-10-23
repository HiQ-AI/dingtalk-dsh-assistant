# R31 续办职责与最终源码验收

最终 backend SHA b3cc15e04ad5f66eac66f17b4063033e3d49e8ccea4cc07b4e8a1c47a541e3a1。关闭系统提示快照后，真实双轮全部 PASS。第一轮创建 calc/check 两名原生队友，实际收件、交叉核算703及关闭排空；第二轮同UUID resume，没有创建队友，精确执行一次指定PowerShell命令，结果包含仅在新definition.prompt出现的DSH_RESUME_INSTRUCTION_R31，证明新轮职责生效。两轮真实exitCode=0、drained=true。

脚本独立比较旧主文档及队友文档SHA不变；wrapper自然退出0，独立回读三个进程都不存在。证据 live-team-proof.json、process-readback.json；完整原始隔离账本留在docs/tmp/interactive-team-live-5。Read曾把目录当文件而收到实际失败，再正确读取文件；未虚构首次即成功，不影响最终只读文档与冻结断言。

最终adapter 50/50、实际固定tarball原生任务/健康2/2；分别见adapter-tests.log和package-native.log。模型与DSH原生服务安装后联调仍需部署后独立验收。未执行钉钉业务外发。

静态检查：302个测试文件映射唯一；源码diff检查通过。源码patch中的单空格行属于unified diff上下文，历史失败日志保留原空白，不为消除样式告警改写证据。
