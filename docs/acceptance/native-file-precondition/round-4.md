# Round 4

见round-4.log。文件路径及存储相关用例通过；扩展provider整文件运行时，两个真实退避/重启恢复用例和不可读终态隔离用例通过。旧冷恢复recovered=false在30秒超时，整轮未完成，精确停止本轮测试父/子进程（60224/35336），未操作正式实例。

此轮不报告全绿。另以基线service复跑同一用例，结果见provider-baseline.log；当前精确现场provider恢复另行运行见provider-field.log。
