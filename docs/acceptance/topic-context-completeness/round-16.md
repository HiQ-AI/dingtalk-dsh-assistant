# Round 16：参考图紧凑步骤时间线

- 对齐用户参考：28px 编号和连续细线、标题右侧耗时、标签/正文对齐、通栏步骤完成比例，窄屏自然换行。
- 节点产出补充已存在的材料正文、文件清单、文件变更、检查结果。不会读取任意工具参数、完整代码或检查日志；校验节点返回原结果时不捏造校验报告。
- `node --test test/observer-client.test.js test/http.test.js test/workflow-service.test.js`：106 PASS，0 FAIL。
- `verify-observer-browser.mjs`：36 项 PASS、27 次隔离 API 请求、0 写入、0 页面错误；桌面 1440px 与窄屏 390px 截图已查看。新增右侧耗时同排、细线与步骤比例检查。
- 浏览器验证使用真实 React/Observer 与语义组件替身、隔离 API；不等于真实钉钉端到端。新增断言最初插入消息页面导致变量初始化错误，已移至任务详情检查点并完整重跑通过。
- strict 界面审计 0 findings；goal 结构检查通过。
- 已安装实现提交 `047f291` 的两个本地 tgz，83 个 JS/YML 安装文件与源码 SHA256 一致，profile patch 未变。
- 备份 `D:/dsh_home/backups/timeline-047f291`，395 个文件，共 477004473 字节；稳定存储 --check 为 ok、invalidRecords=0、strippedFields=0。
- 新 PID 35752 同时监听 3080/18998；health=ok、recoveryIssueCount=0、inboundProcessing=true，认证 Web 200。
- 本地 73 个任务；目标任务保持 completed/succeeded。prepare 返回 219 字且含材料正文，analyze/validate-result 各 161 字且包含真实结果。未重放任务、未发消息。
- 包 SHA256：Assistant `56529C3EDE73EA1CA5FCE76E615206F49858E104EB7B09FBF2FE413495D6D258`；Observer `45434A0FE4C5723EEF4466A9AE5E28250EE49E3A101D2B986A88C459F58571FC`。
- 截图留本机 round-16 目录，不提交 PNG；复现配方见 scripts/verify-observer-browser.mjs。
