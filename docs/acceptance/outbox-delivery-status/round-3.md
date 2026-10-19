# 第三轮：顶部提示关闭

用户补充：连接失败和归档成功提示需要支持自动关闭或手动关闭。复用同一 FeedbackNotice 组件承接三类顶部提示，成功 5 秒关闭，错误支持手动关闭；同一文本和类型不因轮询重新打开，连接恢复后由原刷新路径清除，计时器在替换/卸载时清理。没有通过归档其他业务任务来制造提示。

node --test test/observer-client.test.js test/observer-archive-interaction.test.js：29/29 通过；覆盖 5 秒自动关闭、手动关闭、关闭后的同一错误保持隐藏、新错误重开、刷新不延长成功提示寿命、定时器清理。node --check、git diff --check 和 strict UI audit 均通过。

代码提交 a0120df。复用第二轮 Assistant 包，Observer SHA256 ca26bcf84ab954d368e71571d7d490af275dac775aa50b7e7885f789c5cd159a；原生 Check 通过、SIGINT 排空旧 PID 35384、安装内容校验通过，新 PID 64816 同时持有双端口。独立计算安装 web-client.js 与源码 SHA256 一致；profile 未变、计划任务启用，无历史备份。

健康 inboundProcessing=true、dwsBridge.healthy=true，保留原 1 条未知通知告警，整体 degraded。真实 Chrome 刷新看板正常、无残留错误/归档成功提示。手动关闭和超时行为由组件生命周期测试覆盖，未在真实业务中额外归档任务或制造断网。截图和部署证据在 docs/tmp/notice-dismiss-a0120df*，不提交业务图片。
