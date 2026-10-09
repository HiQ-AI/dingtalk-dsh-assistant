# 首轮实现与反例

本轮实现当前协调澄清合同、Host 准入授权、Owner 工程参数补齐、通知和看板状态。隔离工作树基于 `806ef59714fbc7e899574c1dfd44500e7054c0b1`。

- 服务文件首跑：307 项，288 PASS / 19 FAIL。失败包括旧等待语义和旧 schema 夹具；保留原日志 `docs/tmp/clarification-service-tests/service-round-1.log`，不视为全绿。
- 真实模型首跑：工作方式表达通过；按文档开发的自动断言曾通过，但上下文混入无关旧 SQL 内容，语义证据无效；必要澄清失败 `GROUP_COORDINATOR_NO_DECISION`。原始脱敏结果见 `round-1/native-replay/`。
- 浏览器：状态标签、三类筛选及窄屏键盘路径共 5 项通过，errors=[]、writes=[]。使用完整 Observer/React，宿主 Menu 为语义替身，不证明正式宿主弹层几何或运行实例已部署。见 `round-1/authorization-browser-results.json` 和 `ui-scope.md`；截图仅保留本地，可用脚本再生成。

环境问题：C 盘无临时空间，测试进程改用 D 盘临时目录；随后发现工程子进程 cwd 超过 Windows 路径限制，使用短目录 `D:/codex/docs/tmp/clarification`。未改产品代码掩盖环境错误。
