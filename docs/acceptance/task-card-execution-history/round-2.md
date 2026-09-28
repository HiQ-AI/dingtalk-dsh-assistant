# 后端与交付回归

2026-09-28，独立 worktree，基于 origin/main 3b2d3f9。

## 实跑结果

- `node --test test/workflow-service.test.js test/observer-client.test.js`：最终同轮运行 144/144（服务 132、Observer 12），0 失败。该轮命令还包含未匹配到文件的 `test/workflow-http.test.js`，Node 未执行该名称；随后用准确文件名单独补跑 HTTP，未将其计入本轮 144 项。
- `node --test test/http.test.js`：23/23，0 失败。
- `node --test test/execution-store.test.js test/execution-task-plan.test.js test/execution-effects.test.js test/task-worktree-archive.test.js test/task-sheet-sync.test.js`：76/76，0 失败。
- 新增完整目录用例真实创建 201 个运行，加原任务合计 202 项；最近 200 条列表不含原任务，完整查询仍返回原任务，不触发原生 RPC 队列上限。
- 新增服务用例覆盖整项汇总、分页、取消后阶段成果、旧详情、不可读祖先、非法分页 HTTP 400、不可读详情 404、旧归档 409、最新入口整项归档及同标题独立任务不合并。
- 原生控制用例覆盖关联树、203 条运行、重启重建、缺祖先及循环拒绝、全体终态/租约/效果约束、整项归档原子失败、首个运行前取消的显式 null 绑定、错误身份拒绝。

最初服务回归失败来自测试直接跳过 Owner 完成应用及从旧入口并发重执行；修正测试准备，保持真实门禁。最终正式 Web 路径验证已取消的最新执行可以重执行，并沿可信祖先复用开发分支；旧入口新请求拒绝。

## 真实案例副本

`scripts/verify-live-family-copy.mjs` 只读打开正式 SQLite，并生成一致备份，在副本运行当前原生关联查询和实际汇总函数。HiQ Editor 草稿回显的 7 次执行→1 卡片；数据集合并归一化的 6 次→1 卡片。每项最新卡片的 29 个原字段保持一致。副本 28 张业务表的内容摘要前后完全相同，changedTables=[]。

正式实例在检查期间自行追加了事件和回执；没有据此声称正式库全局不变。副本、私有快照和截图保留 docs/tmp，不提交。此项不代表部署或两项业务重新验收。

## 构建、包和静态核对

- `node scripts/build-web-client.mjs` 成功；Assistant Web 无实际 diff。
- Assistant 和 Observer 分别 `pnpm --dir packages/<package> pack --pack-destination ../../docs/tmp/task-card-packages`。独立回读包大小 580268 / 35246 字节，解包后 Assistant 的 execution-store-worker.js、workflow-service.js、http.js、resident.js 及 Observer web-client.js 与当前源码 SHA256 一致。
- Assistant 包 SHA256：802ab47dcae89663b8b97eac2e124042304cfcc100bea9bb72d6de08f4c04399。
- Observer 包 SHA256：aaba8e8087d0d3dd257d702698ed08d34b01658185c3ea151c4bad6673aeae99。
- frontend-design-premium strict 审计 0 错误、0 警告、0 findings；git diff --check 无错误。

## 边界

本轮相关 243 项测试通过，浏览器独立 18 项见 round-1.md。浏览器使用真实 React/Observer 和只读案例快照，但接口及 DSH 外壳为替身。未安装正式 profile、未重启、未重新执行用户业务、未向群发送消息。
