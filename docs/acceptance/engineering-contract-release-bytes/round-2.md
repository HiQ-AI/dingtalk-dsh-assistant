# 第 2 轮：原发行字节修复与部署恢复

## 修复与反证

恢复 engineering-output-contract.js 的受信发行字节，SHA256 为 8e82c88c2eb226dc1ed880f1f399f60a29f8d51c1929405c879aecacee34561a；.gitattributes 添加 -text whitespace=cr-at-eol。忽略行尾后的源码 diff 为空；没有改变函数逻辑、定义版本、摘要算法、恢复校验或持久化历史。

`node docs/tmp/engineering-definition-drift-probe.mjs current` 在修复后重建唯一 v22 定义，与原持久摘要 9efa68d6ea6e3af247f802a78f9ea302f26b0dae425f358e8486719986e08ee8 精确一致。此探针的只读范围及限制见 round-1。

## 本地测试

`node --test test/engineering-approach-contract.test.js test/paused-task-contract-replay.test.js test/execution-controller.test.js test/task-release-workflows.test.js` 实跑 164 tests / 162 pass / 2 fail / 0 skipped。新合同文件/三个validator摘要、真实Git两种autocrlf checkout、暂停合同和执行控制器回归均通过。

两项失败均为未修改的 task-release-workflows.test.js:20/147 旧摘要常量断言。隔离进程只把合同模块切回原 316b491 发行包字节，并仅运行这两项，得到相同两项失败，确认非本次修复引入。保留失败证据，不修改历史期望值或声称全量通过；此扩展主线缺陷未在本次部署修复范围处理，matrix 保留 FAIL，因此不生成 report.md。

## 部署与回读

修复 Assistant 包 SHA256：7bfa2ed65ba2b7ff47c239a4abb612669ab5672c881d95a89573c39a84fddb31；Observer 沿用原本次部署包 SHA256：9212c1dd11003b6f08a3f113a3c56b715e5be327151ffda6981e9c76231f1e49。两包版本均 1.0.0，以 SHA 绑定构建。

按原失败 launch 指定 RepairStoppedLaunch，新证据目录 docs/tmp/engineering-contract-release-local-20261013-01。统一入口 -Check 为 writes=0；执行 readback ready=true。原生安装、新计划任务启动与完整恢复通过，新 PID 44648 同时监听 3080/18998。没有复制历史备份或修改配置，原 profile SHA 保持。

正式 -Resume 返回 ready=true、dispatchResumed=true；独立 HTTP 回读 health=ok、recoveryIssueCount=0、store/DWS健康。维护退出至 inactive/revision749；控制历史核验 7 tasks、27 oldRuns、47 oldNodes 均保留。Web 凭据交换303、认证首页200，凭据未输出到证据文档。

实际 Runtime 逐项验证 GET /state/task-sheet-sync、POST /task-sheet-sync/check、PUT /config/task-sheet-sync、POST /task-sheet-sync/run，四项均404且error=not_found。未执行真实钉钉消息外发或表格写入。

延迟存活回读：启动约 6 分钟后仍为同一 PID 44648，health=ok、store/DWS健康、维护inactive、派发不受限。工作集约750MiB；这不是此前旧实例 OOM 根因已修复的证明。真实浏览器最终第4次执行通过：独立 headless Edge 读取真实设置页、刷新、整页重载共3项；24次Runtime GET全部200，旧同步请求0，pageerror0，拦截请求0，42次已核对的宿主原生POST正常通过。截图确认环境检查直接衔接Agent配置，重载后health=ok、版本1.0.0。未保存配置/执行任务/发送消息。前轮调整只读RPC白名单及删除非必要toast交互，分轮日志和截图保留在docs/tmp/remove-task-sheet-sync-local-browser-20261013/round-*/。
