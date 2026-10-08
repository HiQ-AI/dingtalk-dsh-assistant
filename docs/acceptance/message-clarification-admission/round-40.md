# Round 40：共享Task材料与产物

复用原work/artifacts及Task目录，不移动会话cwd。新增readTaskMaterials生成导航索引，保留原引用/源版本；Owner与工程同入口按需读取历史材料及任务相对路径产物。索引只筛选业务材料，不倾倒内部控制账。历史文档可用作上下文，不升级为当前授权/验收证明。

实跑 `node --test test/task-file-storage.test.js test/task-owner-session-native.test.js`：35例，34 PASS、1既有SKIP、0 FAIL，3.71秒。证据：docs/tmp/clarification-tests/shared-materials-final.log。覆盖历史正文发现/分页完整读取、新材料即时刷新、outputs产物读取、跨Task及越界拒绝、内部诊断不列入索引、Owner同会话刷新并读旧引用。没有真实群消息、生产数据修改或部署；真实两任务读取与业务结果由后续独立回读证明。


扩展复测：storage、native、delivery-manifest、recovery四文件共68例，67 PASS、1既有SKIP、0 FAIL，10.60秒；独立回读 `docs/tmp/clarification-tests/shared-materials-final3.log`。前一轮final2.log保留66 PASS/1 FAIL/1 SKIP：recovery fixture仅伪造logicalTaskId，没有真实resolver必有的work/tmp/outputs；补完整fixture后通过，实现没有跳过目录校验。新增真实Owner controller流程读取outputs文件后沿原阶段验收完成；索引自身不登记为业务证据，相对文件读取登记readArtifacts。

现有outputs产物按任务/产物子目录保存，因此仅outputs递归导航（拒绝链接），work/tmp不扫描仓库和原生会话。原SHA相对路径读取仍校验摘要。索引保留已有title/fileName/resource，不生成摘要或复制正文。只读计量现场原1edb Task：50个SHA工件、144006 bytes、0摘要损坏，读取/hash/JSON解析225ms；历史文档有resource可辨认。不写现场索引，也未执行现场业务。坏工件明确报错，不静默略过；当前量级无需缓存优化。

最终范围复核：共享读取work/tmp仅顶层，work/artifacts精确SHA保留，outputs允许嵌套。新增engineering仓库package.json/.env、session内部目录及tmp子目录拒绝反例，防止绕过原仓库工具范围。四文件再次实跑68例，67 PASS、1既有SKIP、0 FAIL，13.44秒；独立回读shared-materials-final4.log。源码冻结。
