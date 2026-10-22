# 执行文档模块依赖与测试映射复审

2026-10-22。按 `docs/ops/release-test-mapping.md`、`scripts/test-contracts.mjs` 复审最终 smoke 的 `mixed_destination_changed: test/execution-local-acceptance.test.js`。

原差异只是在隔离测试的复制清单中加入 `execution-context.js`，满足 `session-workspaces.js` 对文档渲染函数的新导入；断言、超时、注册和参数化数量没有变化。复审没有改写固定 Git 基线摘要，也没有增加允许任意更新摘要的路径。最终将 `renderExecutionDocument` 原函数文本移入已经负责文档落盘的 `session-workspaces.js` 并导出，去除该模块间依赖；恢复两处测试复制清单的原行。`execution-context.js` 继续只负责执行上下文投影。

`test/engineering-approach-contract.test.js`、`test/execution-local-acceptance.test.js`、`test/mixed-test-contracts.json`、`scripts/test-contracts.mjs` 最终无工作树差异。原固定基线 202 个注册、220 个展开用例及辅助函数守恒测试通过。

串行实跑：

```powershell
node --test --test-concurrency=1 test/session-workspaces.test.js test/engineering-approach-contract.test.js test/execution-local-acceptance.test.js test/test-suite-contracts.test.js
```

结果 29 PASS、0 FAIL、0 SKIP，22.8 秒，完整日志 `execution-doc-mapping-dependency.log`。包含真实 Git LF/CRLF 冻结身份、tmp/evidence 祖先 junction 外部零写、文档实际文件生成/更新/历史冻结及映射反例。

第一次映射检查通过混合合同后发现 `test_suite_map_stale`，记录于 `execution-doc-mapping-check.log`。逐项比较确定仅 `test/model-context.test.js` 的 `publishedImports` 新增 `session-workspaces.js`，来自本轮新增的真实文档与阶段唤醒测试。运行正式 `node scripts/test-suites.mjs update` 后，独立读取 `git diff -- test/suite-map.json`，确认只新增这一个导入路径；没有变更 lane、category、release、分类理由、发布边界、测试数量或历史入口。

最终 `node scripts/test-suites.mjs check` 输出：`verified 299 files; every file exactly once; historical 3; deleted 0`。日志 `execution-doc-mapping-check-after.log`；更新回执 `execution-doc-mapping-update.log`。本次未改旧执行流程源码、历史测试或共享历史夹具，因此没有重跑完整历史真实进程组；不能将上述定向验证称为全历史验证。
