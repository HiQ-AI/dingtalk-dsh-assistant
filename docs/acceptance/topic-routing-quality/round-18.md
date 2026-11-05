# 第 18 轮：SG6 自动规则验证与旧版服务恢复（阶段记录）

日期：2026-11-05

## 范围与结论

本轮记录 SG6 冻结产品验证、PR 合并和部署暂停期间的旧版正式服务恢复。产品代码验证与合并完成；新规则未安装、未部署、未通过真实新输入验收。恢复的是原已安装的 merge `38f061956fcd73d8c5379fdfa6ae1367da914106` 双包 2.3.0，不代表 SG6 新规则上线或底层 `EPERM` 根因修复。

未写整体 `report.md`，合并后未重复运行已通过的测试，未触发 `-Check`、停机、发送 signal、安装或修改 profile，也未进行业务操作。真实新输入、60 秒观察及 B 门禁仍未完成。

## 版本与合并

- 冻结产品提交：`1ca72d3cc2d99bd5f324999d5678ae3adfc3567c`。仅文档提交 `920421e2` 与其一同经 PR #344 于 `2026-11-05T07:54:53Z` 合并，merge commit 为 `0e52a2ff7136772d4a2f303569c162441c2f2f4b`。测试先运行于冻结工作树，随后绑定相同产品内容；不声称所有测试均在合并提交后重跑。
- 从 merge 独立复打的 Assistant、Observer 包 SHA256 分别为 `eef7295ff7219f8f461f2577c37d36adc4ad0495728d0f2f90d9e6e89345c33e`、`84e114942dab9b4ef60f1b6cf9f40fae889181a5c9d52296bd778aa84d24c1f2`，与实测预打包产物逐字相同。新包未安装。

## 冻结产品验证

- `node --test test/topic-runtime.test.js`：210/210；测试 blob `5536aabb`。
- `node --test --test-name-pattern '模型澄清范围|澄清引用仅凭' test/topic-store.test.js`：范围/回链相关用例 2/2；测试 blob `a17eee2c`。
- 设置原生测试 profile 后执行 `node --test test/topic-routing-clarification-native.test.js`：当前测试 blob `ed518cdc` 整文件 13/13，0 失败、0 跳过。覆盖隔离 Host、问句送达与引用回链、冷恢复、unknown 不重发、epoch 围栏和范围变化；不代表真实钉钉或模型语义验收。
- 通过既有 `RELEASE_PACKAGE_DIRECTORY` 预打包入口执行 `pnpm test:release-smoke`：实际包整组 14/14，0 失败、0 跳过，保留原 30 秒断言；business 29045ms、health 8051ms。smoke 原始输出 SHA256 为 `a01d0c9cf03615a8ee07e534730d23444245bf0887c23fe2849748e7b4286db3`。仅留摘要与摘要哈希，不复制日志或其中可能包含 token 的 web 日志。
- Native 中间曾出现原30秒业务超时及旧夹具缺 scope 失败；按现行引用、补读和范围合同适配夹具，并把同值 scope 测试改为两个真实不同 Topic 后，最终当前 `ed518cdc` 整文件13/13。未放宽原断言或时限；初次超时未取得足够事件，不指定唯一根因。
- 另有组合诊断 455/456：唯一失败是既有固定摘要断言 `actual=第一版`、`expected` 为空。该组合未捕获最终产品 blob，不能绑定为冻结产品上的完整回归；保留失败，不改断言或映射造绿。
- 完整 Service→Resident Native 恶意恢复证明、逐项错误作者/ID/version/epoch 的独立注入未逐一实跑。Store 负例和真实入口源码经过审阅，不将其表述为已实测通过。

再生成上述测试结果的命令：

```powershell
node --test test/topic-runtime.test.js
node --test --test-name-pattern '模型澄清范围|澄清引用仅凭' test/topic-store.test.js
$env:DSH_NATIVE_TEST_PROFILE = 'D:/dsh_home/profiles/web/package.json'; node --test test/topic-routing-clarification-native.test.js
# 将 RELEASE_PACKAGE_DIRECTORY 指向本轮同一组预打包产物后执行：
pnpm test:release-smoke
```

## 部署暂停与旧版服务恢复

部署前只读状态为：旧 PID 10052 已退出；无 web 进程、监听端口或后代进程；owner 为空、未排空计数为 0、`starting=0`。末端错误栈定位于已安装上游 `storage-json` 0.2.1-rc.2 的 `writeAtomic`：同目录随机临时文件 rename 返回 `EPERM`；触发条件和精确退出时点未收敛，不能归因于 SG6 路由代码，也不能声称该上游问题已修复。

`2026-11-05T08:06:38.567592Z` 仅启动原已安装 merge `38f06195` 的双包 2.3.0 计划任务一次，没有更换包或 profile。后台任务 `bthyqsefs` exit 0；Lead 于 `2026-11-05T08:10:12.6184408Z` 完整读回：PID 28268，进程创建时间 `2026-11-05 16:06:41.173187+08:00`；端口 3080、18998 同属该 PID；health `ok`、inbound/bridge healthy、`recoveryIssueCount=0`；计划任务 `Running`、autostart=true。profile patch SHA256 `1f2c3b27f47d2635c5c02c22c5965ec6c1d12b3516c86d77de7a8a4813e59f55`。Lead 独立核对 profile 指向原受信 Assistant `fd7debd7...8d7ae`、Observer `84e11494...c1f2`，与启动前一致。

结论：旧版服务恢复通过；SG6 新规则部署暂停且未验证。服务恢复、健康状态和包 hash 一致均不证明新规则已安装或线上可用。没有本轮 `-Check`、新包安装或真实输入验收。

旧轮附件保留说明：第16轮四份 TAP 及第15/16轮已无用途的临时打包/部署回执目录已清理；旧轮报告、原矩阵结果、摘要及必要文字证据保留，不转移备份。当前候选包与本轮 smoke 输出仍保留供暂停后的部署续接；原始业务证据不入库。
