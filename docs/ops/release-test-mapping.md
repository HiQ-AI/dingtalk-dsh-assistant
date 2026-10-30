# 发行测试映射与历史手动入口

`test/suite-map.json` 递归覆盖全部仓库测试文件。`node scripts/test-suites.mjs check` 核对文件、导入闭包及混合注册；遗漏、重复、未知测试扩展或未复审的混合注册/夹具变化均拒绝检查。`update` 只更新映射，不批准历史退出。未审定的新文件保守纳入Release，history文件名不授予退出资格。

## 门禁与资源隔离

Release六个独立Windows runner执行当前产品、保留兼容保证及未知保守覆盖：unit并发4，native两组及compat三组各并发1。history独立串行，只用于本地显式调用或手动CI，不加入版本tag的validate。不能按名称或静态旧导入整组退出。

`pnpm test` / `pnpm test:all` 顺序执行全部七组，失败即停，递归映射避免顶层glob漏测；不在同机增加原生或真实进程并发。默认本地仍只运行本次相关测试。沿用每run独立短物理TEMP、专属原生目录ACL准备、文件进程隔离和原超时。

## 首次逐注册审定

来源固定为 `7ca36c26ad1c52e8b1896fdc76a7e8aed1c9a697`。`test/mixed-test-contracts.json` 保存原行号/ID、语句SHA256、参数变体数、目标、合同类别、理由和证据。原注册及循环整体迁移，断言、超时、清理均保留。

| 原文件 | 原注册/展开用例 | Release注册 | 历史注册/展开用例 |
| --- | --- | --- | --- |
| workflow-engineering | 31/45 | 2 | 29/43 |
| execution-local-acceptance | 22/26 | 2 | 20/24 |
| runtime | 149/149 | 34 | 115/115 |
| 合计 | 202/220 | 38 | 164/182 |

映射记录55个发布JS根及55个静态本地闭包路径。这只解析字面量相对导入，不宣称通用JS依赖分析。旧runtime、工程Run/节点、本地验收runner不在发布闭包；README与清洁启动合同明确旧固定工程/UAT入口及旧Task/Run迁移退役，结合逐注册审查才归历史。仍发布的Store/Topic/Bridge、session-workspaces相关混合断言和不能充分证明退出者保守留Release。

工程原#1的junction越界/外部零写、验收原#19的tmp/evidence祖先junction及无执行预约均留门禁。工程原#9保留v10工厂在localAcceptance变化时的摘要不变性，属于相对摘要合同而非写死SHA快照。其他测试中的冻结源码字节及固定摘要合同仍留Release，未因旧模块未发布而退出。验收原#20的换行/源码身份合同也保守保留。

共享夹具在 `test/fixtures/*-mixed.js`。保留混测仍加载旧Runtime，不能声称完全移除旧模块加载成本。未新增顶层Git/HTTP/进程；原Runtime两个临时工作区及清理钩子照旧。守恒契约从固定Git blob核对原注册、变体、共享夹具及保留ID，需要完整Git历史；不能只更新hash消除合同变化。

## 手动验证

```powershell
pnpm test:suites
# 全历史执行较慢，仅明确需要时运行
pnpm test:history
# 仅相关历史文件，保持串行
pnpm test:history test/workflow-engineering-history.test.js
# 仅相关用例，适合小范围诊断
node --test --test-concurrency=1 --test-name-pattern='工程源仓库缺失' test/workflow-engineering-history.test.js
```

修改旧工程/验收/Runtime源码、对应历史入口或共享夹具时，显式运行相关历史文件/用例，不以Release成功替代相关验证。仍按npm-release runbook准备JDK/Node22/合成profile等实际依赖。旧流程发生变化时重审分类及保证，不为掩盖失败迁移测试。

已审定注册需要修复时，保留原 SHA256、原 ID、变体数及分类，另记包含前后摘要、basis commit、理由和证据的 `review`；不能只刷文件摘要。当前内容必须匹配复审摘要，原 Git 来源仍逐项核对。2.3.0 的三项输入/依赖夹具复审及一项共享 helper 变更见[发行测试恢复](release-230-test-recovery.md)。

手动ci.yml的scope=all执行七组，scope=history仅执行历史组；无push/PR/定时触发。触发CI仍需用户明确授权。

## 收益与发行边界

本次将182个历史展开用例移至独立手动入口，不按数量推算提速。父线程对既有成功run的观察：unit14s、native1 97s、native0 238s、compat1 307s；compat0/2曾超过10分钟，最终compat0最长。这里未独立读取原日志；候选未触发CI，不能给出整体节省秒数。环境准备和其余未审定覆盖仍可能主导长尾。

validate六组成功后，build/publish仍只用同run、精确SHA的三包及摘要清单。本次不改artifact名称、同run下载、NPM_PUBLISH环境或OIDC权限，不改v2.1.0 tag/包，不缓存测试结论。失败、取消、跳过、环境阻塞分别报告，阻塞不能计为通过。
