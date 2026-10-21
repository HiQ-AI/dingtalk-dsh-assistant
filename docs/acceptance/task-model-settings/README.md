# 任务统筹模型配置验收

基线 `94f99720836e134f0615dc7e02f0f4d4bd72b7e9`，独立分支 `fix/task-session-model-settings`。未引入协调开发分支、依赖或锁文件变更；未安装、重启或修改生产配置。

## 验证

- 前序相关单元/UI合同组合 100/100 通过；后续只跑受影响测试。
- `node --test test/task-model-config.test.js test/client.test.js`：9/9，通过读写/重开持久化、旧配置三模式、无全局默认写入、组合与默认深度修改的严格拒绝。
- 使用 DSH 0.2.1-rc.2，`node --test test/task-model-reasoning-native.test.js test/task-session-model-native.test.js`：6/6（与上项 config 两例组合执行共8/8）。脚本化原生适配器记录真实调用参数，覆盖执行隔离、原 Session resume、运行中深度不变、模型默认重设、unsupported失败不写历史；未调用真实模型。
- `scripts/browser.mjs`：真实 Chromium、React 与生成发布 bundle、完整页面CSS；API均由内存fixture接管。验证保存/刷新、执行配置不变、模型能力联动、失败草稿保留、旧刷新晚返回不能覆盖保存成功、390px无溢出，无页面异常。
- Premium strict audit：0 errors / warnings / violations。独立只读复审发现并复核修复最终组合校验及过期刷新竞态，最终无阻断。

## 截图

真实页面截图已保存Library：

- 桌面成功态：`libfile_3b3456a7c2548191a3391cbfef2012f4`
- 窄屏错误态：`libfile_35320214aa4c8191819b2ca94855defe`

## 边界

这是隔离本地候选，未PR/推送/合并/部署。未验证生产宿主完整页面集成及真实模型凭据、余额和远端调用成功。旧配置继续继承默认深度；保存后下一轮创建或正常恢复生效，活动轮次不被中断。

## 布局调整复验

默认处理模型与统筹模型均位于 Agent 配置，模型和深度各占一列，两行对齐，窄屏按组折行。模型复用相同输入/原生候选列表组件，深度来自各自原生模型能力并共用值及中文标签；统筹保留三语义与独立配置，隐藏独立provider控件但原provider仍保留，不改变astra默认。

本次只跑受影响UI测试7/7、真实Chromium完整CSS交互与列坐标断言，并检查两行候选及深度标签一致。保存/刷新/联动/失败草稿/旧刷新竞态及390px无溢出通过；独立只读复审无阻断。未重跑原生及前序100组合，因为接口、存储和执行参数没有改动。

更新截图（替代上方旧布局截图）：桌面 `libfile_149f8e4612d08191b662c58f1e3b1bca`；窄屏 `libfile_df89be5492d88191b634efc1ae021c7c`。
