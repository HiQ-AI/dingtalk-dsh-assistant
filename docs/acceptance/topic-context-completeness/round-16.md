# Round 16：参考图紧凑步骤时间线

- 对齐用户参考：28px 编号和连续细线、标题右侧耗时、标签/正文对齐、通栏步骤完成比例，窄屏自然换行。
- 节点产出补充已存在的材料正文、文件清单、文件变更、检查结果。不会读取任意工具参数、完整代码或检查日志；校验节点返回原结果时不捏造校验报告。
- `node --test test/observer-client.test.js test/http.test.js test/workflow-service.test.js`：106 PASS，0 FAIL。
- `verify-observer-browser.mjs`：36 项 PASS、27 次隔离 API 请求、0 写入、0 页面错误；桌面 1440px 与窄屏 390px 截图已查看。新增右侧耗时同排、细线与步骤比例检查。
- 浏览器验证使用真实 React/Observer 与语义组件替身、隔离 API；不等于真实钉钉端到端。新增断言最初插入消息页面导致变量初始化错误，已移至任务详情检查点并完整重跑通过。
- 本地安装与只读回读待完成。
