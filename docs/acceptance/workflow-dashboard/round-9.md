# Round 9：配置深链接被异步读回覆盖

日期：2026-10-13。前 10 项配置检查通过：普通创建回读/编辑、不可变名称种类、JSON 校验、secret 遮蔽/显示/替换/不回读、空秘密拒绝、保存错误与 409 保留、dirty 导航和取消、流程绑定保存。

失败用例：配置页最后选择 `fixtureSecret`，保存 `settings → fixturePlain` 和 `token → fixtureSecret` 绑定后，切至工作流详情并点击 `fixturePlain` 的「查看配置」。回到配置页最终仍选择 `fixtureSecret`，未呈现目标普通变量。

定位：配置读取 effect 捕获旧 draft；target effect 提前消费 `lastTarget` 并选择目标；配置请求返回时因为 `lastTarget` 已相等，读取 effect 回退闭包旧 draft，将目标选择覆盖。原始 JSON 与失败截图分别位于 `round-9/browser-results.json` 和本地 `docs/tmp/workflow-dashboard/round-9/configuration-failure.png`。生产源码 SHA256 与 round 8 相同，已交由主实现者修复。

此轮仅调用白名单 Playwright API 夹具，无真实运行时外发或业务写入。后续停用、窄屏及过期读取检查尚未执行。
