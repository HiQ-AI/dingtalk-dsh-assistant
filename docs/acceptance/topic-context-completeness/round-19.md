# Round 19：构建检查与业务验收分离

## 实现

- 新工程定义 v10 在 verify-candidate 后新增 business-acceptance，再进入 prepare-commit。构建检查与业务验收独立命名；旧登记定义保留原执行历史，新任务和受管重发使用 v10。
- Host acceptanceChecks 固定验收项与预期，执行于冻结候选副本。全部命令成功且末步 JSON actual 与 expected 精确相等才通过；缺配置、空回执或不匹配均等待、阻止提交，并停止自动恢复循环。
- 准备提交仅复用同进程可信验收票据，重启重新运行。候选变化不能套用旧验收记录；交付证明对 v10 额外要求同候选的业务验收节点。
- 页面展示构建节点及独立验收结论，成功产出含验收项/预期/实际；等待原因明确中文，失败日志仍保存到 evidenceRefs。未重跑旧任务、未补造历史验收。

## 证据

- `node --test test/task-workflow.test.js test/workflow-engineering.test.js test/workflow-service.test.js test/observer-client.test.js test/execution-controller.test.js`：123 PASS，0 FAIL/skip，115783ms。
- 实际临时 Git 候选验证：构建通过但缺验收配置拒绝；退出0却无 actual 拒绝；预期2t实际1t拒绝；真实控制器处于 waiting、下游提交0次、失败证据已持久；预期1t实际1t放行；重建实例不采信输入票据而重跑；变更到0.001t后旧票据不可放行。工程完整交付及第二轮修改回归通过。
- 交付证明反例首次因测试新工件引用漏 artifact: 前缀失败，修正夹具后全组通过。实现仍对缺失工件验收字段拒绝放行。
- 浏览器43项 PASS、40次隔离API请求、0写入/页面错误。已查看窄屏截图，构建在前、业务验收在后，缺用例时显示等待。截图为完整Observer+React夹具、宿主组件语义替身；PNG留本机，可由同目录scripts/verify-observer-browser.mjs再生成。
- 旧 v9 工厂与当前安装688c2f3文件独立生成定义，摘要完全一致，见 round-19/definition-check.json。初次用git show的LF文本和Windows工作文件比较出现差异，改以实际安装文件为基准保留换行后相等；未放宽定义保护。

## 边界

本轮交付验收门禁与Host执行协议；没有为dataset编写或配置真实业务用例，不能声称归一化问题已业务验收通过。Host配置需要能覆盖具体需求的回归用例，静态字符串或通用构建不能替代；修改冻结配置需新受管任务，旧任务不热改定义。业务失败细节保存在失败证据链，页面当前展示阻塞原因；成功验收显示具体预期和实际。
