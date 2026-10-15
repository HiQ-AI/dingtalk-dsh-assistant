# 授权上下文与等待说明首轮回归

- 核心13项：11通过、2失败。实际近期来源开始进入执行上下文后，原目录预算把35KB真实正文也计入了目录开销；另一个断言未解码contentRef。修正测试口径：真实正文只计一次，目录剩余开销仍小于17000，源数量增长预算不放宽。
- Observer93项全部通过；strict premium audit无finding，DESIGN lint零错误/警告。
- 真实Chrome保留原长等待说明截图waiting-before.png。截图仅本地保存；复现路径为本机3080运行看板→任务看板→修复专家审核后申请撤回限制。
- 完整输出见round-21/core-tests.log、observer-tests.log、premium-audit.json和design-lint.log。
