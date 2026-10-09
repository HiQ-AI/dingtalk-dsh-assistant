# 第65轮：控制库首因与健康观测

现场重复STORE_UNAVAILABLE：09:08只读quick_check正确、maintenance517 inactive、busy与unknown均0；09:10同Host Resident重开恢复。首次错误原code/action尚无证据，不把重开当根修。

execution-store父进程保留首次故障code/SQLite码/动作/时点/请求SHA，不记录SQL、原错误正文、原消息、参数或命令ID原文。运行期追加控制库同目录execution-store-failures.jsonl，正常关闭不误记；首次异常不被后续worker退出覆盖。workflow-service/resident/http health增加同步executionStore健康及首因，不通过失效控制库RPC取诊断。

定向原生测试4/4 PASS（docs/tmp/store-first-failure-test.log，12.72秒）：真实COMMIT ACK丢失仍封闭且重开按原ID读回、原生SQLITE_FULL仍整事务回滚且保留13码、诊断无secret/命令ID原文、关闭不产生文件、64队列边界保持。HTTP相关4/4 PASS（store-health-http-test.log，0.80秒）：bridge正常但控制库失败也degraded，首因可回读。未跑全仓测试。

只完成可追溯观测，不放宽提交未知/SQLite封闭边界、不新增自动重试。下一真实故障需由持久首因定位并修正；SG25仍未收敛。
